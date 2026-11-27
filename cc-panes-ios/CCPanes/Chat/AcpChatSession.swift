import Foundation
import Observation
import os

private let log = Logger(subsystem: "com.ccpanes.ios", category: "acp-session")

/// 单个对话的连接状态机：取快照 → 连 WS（afterSeq 续传）→ 帧缓冲 16ms 合批进 reducer。
/// 每次 attach 一个新世代，迟到的旧连接帧一律丢弃；断线指数退避重连，带最后 seq 续传。
@MainActor
@Observable
final class AcpChatSession {
    enum Link: Equatable {
        case connecting, live, reconnecting, suspended, hostUnavailable, failed(String)
    }

    let chatId: String
    private(set) var state = AcpChatState()
    private(set) var link: Link = .connecting
    /// 写操作被服务端 403 拒绝过（远程只读）。
    private(set) var readOnly: Bool
    private(set) var actionError: String?
    private(set) var busy = false

    @ObservationIgnored private let service: any AcpService
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var retryTask: Task<Void, Never>?
    @ObservationIgnored private var flushTask: Task<Void, Never>?
    @ObservationIgnored private var pending: [AcpFrame] = []
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var retryAttempt = 0
    @ObservationIgnored private let flushInterval: Duration

    init(chatId: String, service: any AcpService, canWrite: Bool, flushInterval: Duration = .milliseconds(16)) {
        self.chatId = chatId
        self.service = service
        self.readOnly = !canWrite
        self.flushInterval = flushInterval
    }

    var isGenerating: Bool { state.phase == .generating }
    var canSend: Bool { !readOnly && link == .live && !state.phase.isTerminal && state.phase != .starting }

    // MARK: - Lifecycle

    func attach() {
        generation += 1
        let gen = generation
        teardown()
        link = retryAttempt == 0 ? .connecting : .reconnecting
        let afterSeq = state.lastSeq
        let service = self.service
        let chatId = self.chatId
        streamTask = Task { [weak self] in
            if afterSeq == 0, let (snapshot, _) = try? await service.detail(chatId: chatId) {
                guard let self, self.generation == gen else { return }
                if self.state.snapshot == nil { self.state.snapshot = snapshot }
            }
            let frames = await service.openStream(chatId: chatId, afterSeq: afterSeq)
            for await frame in frames {
                guard let self, self.generation == gen else { return }
                self.receive(frame, generation: gen)
            }
            // 流未带 .closed 就结束（被取消以外）：同样按断线处理
            guard let self, self.generation == gen, !Task.isCancelled else { return }
            self.receive(.closed(status: nil), generation: gen)
        }
    }

    func suspend() {
        generation += 1
        teardown()
        flushNow()
        link = .suspended
    }

    func resume() {
        guard link == .suspended else { return }
        retryAttempt = 0
        attach()
    }

    func detach() {
        generation += 1
        teardown()
    }

    // MARK: - Frames

    private func receive(_ frame: AcpFrame, generation gen: Int) {
        switch frame {
        case .closed(let status):
            flushNow()
            state.apply(frame)
            if status == 503 { link = .hostUnavailable }
            if status == 403 { readOnly = true }
            if status == 401 { link = .failed(APIError.tokenRejected.localizedDescription) }
            scheduleRetry(slow: status == 503 || status == 401)
        case .synchronized:
            pending.append(frame)
            flushNow()
            link = .live
            retryAttempt = 0
        default:
            pending.append(frame)
            scheduleFlush()
        }
    }

    /// 合批：流式 chunk 每帧都触发 @Observable 变更就是渲染风暴，攒 16ms 一次性进 reducer。
    private func scheduleFlush() {
        guard flushTask == nil else { return }
        let interval = flushInterval
        flushTask = Task { [weak self] in
            try? await Task.sleep(for: interval)
            guard !Task.isCancelled else { return }
            self?.flushNow()
        }
    }

    func flushNow() {
        flushTask?.cancel()
        flushTask = nil
        guard !pending.isEmpty else { return }
        var next = state
        for frame in pending { next.apply(frame) }
        pending.removeAll()
        state = next
    }

    private func scheduleRetry(slow: Bool) {
        generation += 1
        let gen = generation
        teardown()
        let seconds = slow ? 10 : min(30, 1 << min(retryAttempt, 5))
        retryAttempt += 1
        if case .failed = link {} else if link != .hostUnavailable { link = .reconnecting }
        log.info("retry in \(seconds, privacy: .public)s afterSeq=\(self.state.lastSeq, privacy: .public)")
        retryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard let self, self.generation == gen else { return }
            self.attach()
        }
    }

    private func teardown() {
        streamTask?.cancel()
        streamTask = nil
        retryTask?.cancel()
        retryTask = nil
    }

    // MARK: - Actions

    func send(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, canSend else { return }
        flushNow()
        let promptId = "ios-\(UUID().uuidString.lowercased())"
        state.addLocalUser(trimmed, promptId: promptId)
        await perform { [service, chatId] in try await service.prompt(chatId: chatId, text: trimmed, promptId: promptId) }
    }

    func cancelTurn() async {
        await perform { [service, chatId] in try await service.cancel(chatId: chatId) }
    }

    func setMode(_ id: String) async {
        await perform { [service, chatId] in try await service.setMode(chatId: chatId, modeId: id) }
    }

    func setModel(_ id: String) async {
        await perform { [service, chatId] in try await service.setModel(chatId: chatId, modelId: id) }
    }

    func setConfigOption(_ configId: String, value: String) async {
        await perform { [service, chatId] in
            try await service.setConfigOption(chatId: chatId, configId: configId, value: value)
        }
    }

    func stop() async {
        await perform { [service, chatId] in try await service.stop(chatId: chatId) }
    }

    func respondPermission(_ key: String, optionId: String?) async {
        guard let i = state.pendingPermissions.firstIndex(where: { $0.requestKey == key }),
              !state.pendingPermissions[i].responding else { return }
        state.pendingPermissions[i].responding = true
        state.pendingPermissions[i].error = nil
        let error = await performCapturing { [service, chatId] in
            try await service.respondPermission(chatId: chatId, requestKey: key, optionId: optionId)
        }
        // 成功才出队；失败保留原卡供重试（与桌面同）。permission_resolved 也会移除，幂等。
        if let error, let j = state.pendingPermissions.firstIndex(where: { $0.requestKey == key }) {
            state.pendingPermissions[j].responding = false
            state.pendingPermissions[j].error = error
        } else if error == nil {
            state.resolvePermission(key)
        }
    }

    func respondQuestion(_ key: String, response: JSONValue) async {
        guard let i = state.pendingQuestions.firstIndex(where: { $0.requestKey == key }),
              !state.pendingQuestions[i].responding else { return }
        state.pendingQuestions[i].responding = true
        let error = await performCapturing { [service, chatId] in
            try await service.respondElicitation(chatId: chatId, requestKey: key, response: response)
        }
        if let error, let j = state.pendingQuestions.firstIndex(where: { $0.requestKey == key }) {
            state.pendingQuestions[j].responding = false
            state.pendingQuestions[j].error = error
        } else if error == nil {
            state.resolveQuestion(key)
        }
    }

    func clearActionError() { actionError = nil }

    private func perform(_ body: @escaping @Sendable () async throws -> Void) async {
        if let error = await performCapturing(body) { actionError = error }
    }

    /// 执行写操作；403 → 切只读；返回错误文案（nil = 成功）。
    private func performCapturing(_ body: @escaping @Sendable () async throws -> Void) async -> String? {
        busy = true
        defer { busy = false }
        do {
            try await body()
            return nil
        } catch let error as AcpError {
            if case .readOnly = error { readOnly = true }
            if case .hostUnavailable = error { link = .hostUnavailable }
            return error.localizedDescription
        } catch {
            return error.localizedDescription
        }
    }
}
