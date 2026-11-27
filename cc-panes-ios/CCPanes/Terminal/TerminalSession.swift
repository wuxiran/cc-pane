import Foundation
import Observation
import os

private let log = Logger(subsystem: "com.ccpanes.ios", category: "terminal-session")

/// 单个会话的终端状态机：连 WS（缓冲）→ 取恢复快照 → 去重拼接 → 实时流。
/// 每次 attach 一个新世代，迟到的旧连接/旧快照一律丢弃。
@MainActor
@Observable
final class TerminalSession {
    enum Phase: Equatable {
        case connecting, reconnecting, connected, suspended, exited(Int?), failed(String)
    }

    let sessionId: String
    let canWrite: Bool
    private(set) var phase: Phase = .connecting
    /// 共享 PTY 当前网格（来自快照几何；本端 resize 后更新）。
    private(set) var ptyGeometry: TerminalGeometry?

    /// 终端渲染接收端：reset 清屏，write 写入 VT 文本。由 TerminalHost 绑定。
    @ObservationIgnored var sink: TerminalSink?

    @ObservationIgnored private let api: APIClient
    @ObservationIgnored private var socket: TerminalSocket?
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var retryTask: Task<Void, Never>?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var retryAttempt = 0
    @ObservationIgnored private var resyncToken = 0
    @ObservationIgnored private var sequencer = OutputSequencer()

    init(sessionId: String, api: APIClient, canWrite: Bool) {
        self.sessionId = sessionId
        self.api = api
        self.canWrite = canWrite
    }

    var isInteractive: Bool { canWrite && phase == .connected }

    // MARK: - Lifecycle

    func attach() {
        if case .exited = phase { return }
        generation += 1
        let gen = generation
        log.info("attach gen=\(gen, privacy: .public)")
        teardown()
        phase = retryAttempt == 0 ? .connecting : .reconnecting
        sequencer.reset()

        // 1) 先连 WS 并缓冲，保证快照与实时流之间没有缺口
        let socket = TerminalSocket(request: api.terminalSocketRequest(sessionId: sessionId))
        self.socket = socket
        let events = socket.open()
        streamTask = Task { [weak self] in
            for await event in events {
                guard let self, self.generation == gen else { return }
                self.handle(event, generation: gen)
            }
        }

        // 2) 取快照，写入后冲刷缓冲
        resync(generation: gen)
    }

    /// 取快照并与缓冲中的实时帧拼接。desync 时在同一条 WS 上原地重做，不断线重连
    /// （整条重连在高频输出下会陷入「desync→重连→desync」循环，期间无法输入/resize）。
    private func resync(generation gen: Int) {
        resyncToken += 1
        let token = resyncToken
        sequencer.reset()
        Task { [weak self] in
            guard let self else { return }
            do {
                let restored = try await self.loadSnapshot()
                guard self.generation == gen, self.resyncToken == token else { return }
                log.info("snapshot applied gen=\(gen, privacy: .public) endSeq=\(restored.endSeq ?? 0, privacy: .public)")
                self.apply(restored)
                self.retryAttempt = 0
                // WS 可能在快照途中已收到 exit；那时保持 exited
                if case .exited = self.phase {} else { self.phase = .connected }
            } catch let error as APIError where !error.isNetwork {
                guard self.generation == gen else { return }
                self.phase = .failed(error.localizedDescription)
                self.teardown()
            } catch {
                guard self.generation == gen else { return }
                self.scheduleRetry()
            }
        }
    }

    func suspend() {
        generation += 1
        teardown()
        if case .exited = phase { return }
        phase = .suspended
    }

    func resume() {
        guard phase == .suspended else { return }
        retryAttempt = 0
        attach()
    }

    func detach() {
        generation += 1
        teardown()
    }

    // MARK: - Input

    func send(_ text: String) {
        guard isInteractive else { return }
        socket?.sendInput(text)
    }

    /// 「适配手机」：把共享 PTY 改成本端网格（会影响电脑端同一会话的排版）。
    func resizePty(cols: Int, rows: Int) {
        guard isInteractive, cols >= 2, rows >= 1 else { return }
        log.info("resize pty to \(cols, privacy: .public)x\(rows, privacy: .public)")
        socket?.sendResize(cols: cols, rows: rows)
        ptyGeometry = TerminalGeometry(cols: cols, rows: rows)
    }

    // MARK: - Internals

    private struct Restored {
        var photo: String?
        var delta: String
        var endSeq: UInt64?
        var geometry: TerminalGeometry?
    }

    private func loadSnapshot() async throws -> Restored {
        do {
            if let r = try await api.recoverySnapshot(sessionId) {
                return Restored(photo: r.checkpoint?.snapshotAnsi, delta: r.delta, endSeq: r.endSeq, geometry: r.geometry)
            }
            return Restored(photo: nil, delta: "", endSeq: nil, geometry: nil)
        } catch APIError.http(404, _) {
            let legacy = try await api.replaySnapshot(sessionId)
            return Restored(photo: nil, delta: legacy?.data ?? "", endSeq: nil, geometry: nil)
        }
    }

    private func apply(_ restored: Restored) {
        if let geometry = restored.geometry { ptyGeometry = geometry }
        sink?.reset(geometry: ptyGeometry)
        if let photo = restored.photo, !photo.isEmpty { sink?.write(photo) }
        if !restored.delta.isEmpty { sink?.write(restored.delta) }
        let backlog = sequencer.snapshotApplied(endSeq: restored.endSeq)
        if !backlog.isEmpty { sink?.write(backlog) }
    }

    private func handle(_ event: TerminalEvent, generation gen: Int) {
        switch event {
        case .output(let data, let endSeq):
            if let text = sequencer.accept(.init(data: data, endSeq: endSeq)), !text.isEmpty {
                sink?.write(text)
            }
        case .exit(let code):
            // 不推进世代：快照若尚在途中仍应写入，让用户看到退出前的画面
            phase = .exited(code)
            socket?.close()
            socket = nil
        case .desync:
            log.info("desync gen=\(gen, privacy: .public): resync in place")
            resync(generation: gen)
        case .closed:
            if self.generation == gen { scheduleRetry() }
        }
    }

    private func scheduleRetry() {
        if case .exited = phase { return }
        generation += 1
        let gen = generation
        teardown()
        let seconds = min(30, 1 << min(retryAttempt, 5))
        retryAttempt += 1
        phase = .reconnecting
        retryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard let self, self.generation == gen else { return }
            self.attach()
        }
    }

    private func teardown() {
        if socket != nil { log.info("teardown closes socket") }
        streamTask?.cancel()
        streamTask = nil
        retryTask?.cancel()
        retryTask = nil
        socket?.close()
        socket = nil
    }
}

/// 终端渲染端抽象（SwiftTerm 视图实现；测试可替换）。
@MainActor
protocol TerminalSink: AnyObject {
    func reset(geometry: TerminalGeometry?)
    func write(_ text: String)
}
