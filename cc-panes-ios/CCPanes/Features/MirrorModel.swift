import Foundation
import Observation

/// 「终端」tab：5s 轮询 layout-snapshot（新旧 profileId 择新）+ /api/sessions，合成电脑布局镜像。
/// 同时承担手机端启动/关闭会话（启动记录进「手机远程会话」组）。
@MainActor
@Observable
final class MirrorModel {
    private(set) var state = MirrorState()
    private(set) var loaded = false
    private(set) var error: String?
    /// sessionId → 最近一段有意义的输出（降噪后，见 `meaningfulPreview`）。卡片可见时按需刷新（节流）。
    private(set) var previews: [String: String] = [:]
    /// 每轮轮询 +1：可见卡片据此触发预览刷新。
    private(set) var tick = 0

    private let api: APIClient
    private var localLaunches: [String: LocalLaunch] = [:]
    private var names: [String: LaunchRecord] = [:]
    private var previewFetchedAt: [String: Date] = [:]
    /// 调试：`-mockMirror YES` 用内置样例布局（无电脑 / 截图用），不访问镜像接口。
    private let mock: Bool
    /// 最近一轮拉取是否失败（连接健康度信号；已有画面时 `error` 不会被置上）。
    private(set) var lastRefreshFailed = false
    /// 已查过 launch-history 的孤儿 id（查不到名字也不再反复拉）。
    private var namesLookedUp = Set<String>()

    init(api: APIClient, mock: Bool = UserDefaults.standard.bool(forKey: "mockMirror")) {
        self.api = api
        self.mock = mock
    }

    /// 页面存活期间轮询；任务取消即停。
    func poll() async {
        while !Task.isCancelled {
            await refresh()
            try? await Task.sleep(for: MirrorConfig.pollInterval)
        }
    }

    func refresh() async {
        defer { tick += 1 }
        if mock {
            state = buildMirrorState(snapshot: MirrorFixture.snapshot(), running: MirrorFixture.sessions(),
                                     localLaunches: localLaunches, names: names, now: .now)
            loaded = true
            return
        }
        let api = self.api
        async let snapshotResult = Self.fetchCurrentSnapshot(api)
        async let sessionsResult = Self.capture { try await api.sessions() }
        let (snapshot, sessions) = await (snapshotResult, sessionsResult)
        switch snapshot {
        case .success(let value):
            state = buildMirrorState(snapshot: value, running: (try? sessions.get()) ?? [],
                                     localLaunches: localLaunches, names: names, now: .now)
            error = nil
            lastRefreshFailed = false
        case .failure(let failure):
            lastRefreshFailed = true
            // 已有数据时保留旧画面，只在首次加载失败时显示错误（同 Flutter）
            if !loaded || state.isEmpty { error = failure.localizedDescription }
        }
        loaded = true
        await refreshNamesIfNeeded()
    }

    /// 卡片可见时调用：取最近输出、降噪后作预览；同一会话 15s 内不重复拉。
    func loadPreview(for sessionId: String) async {
        if let last = previewFetchedAt[sessionId], Date.now.timeIntervalSince(last) < 15 { return }
        previewFetchedAt[sessionId] = .now
        let lines: [String]
        if mock {
            lines = MirrorFixture.output(sessionId)
        } else {
            guard let fetched = try? await api.sessionOutput(sessionId, lines: 24) else { return }
            lines = fetched
        }
        previews[sessionId] = meaningfulPreview(lines)
    }

    /// 手机在项目里启动会话；成功返回 sessionId。
    func launch(project: WorkspaceProject, workspaceName: String?, tool: CliTool, resumeId: String? = nil) async throws -> String {
        // 新会话按手机竖屏的大致网格创建；终端页可「适配手机尺寸」
        let id = try await api.createSession(projectPath: project.path, workspaceName: workspaceName,
                                             cliTool: tool, resumeId: resumeId, cols: 60, rows: 40)
        localLaunches[id] = LocalLaunch(sessionId: id, projectPath: project.path, workspaceName: workspaceName,
                                        cliTool: tool == .none ? nil : tool.rawValue, title: project.displayName)
        await refresh()
        return id
    }

    func kill(_ sessionId: String) async throws {
        defer { localLaunches[sessionId] = nil }
        try await api.killSession(sessionId)
        await refresh()
    }

    nonisolated private static func fetchCurrentSnapshot(_ api: APIClient) async -> Result<LayoutSnapshot?, any Error> {
        async let scoped = capture { try await api.layoutSnapshot(profileId: scopedLayoutProfileId) }
        async let legacy = capture { try await api.layoutSnapshot(profileId: legacyLayoutProfileId) }
        return await pickCurrentSnapshot(scoped: scoped, legacy: legacy)
    }

    /// 孤儿会话用 launch-history 起名；只有出现未知孤儿时才拉。
    private func refreshNamesIfNeeded() async {
        let orphanIds = state.groups.first { $0.kind == .orphan }?.cards.map(\.sessionId) ?? []
        let unknown = orphanIds.filter { !namesLookedUp.contains($0) }
        guard !unknown.isEmpty, let records = try? await api.launchHistory(limit: 300) else { return }
        namesLookedUp.formUnion(unknown)
        for record in records {
            if let pty = record.ptySessionId, names[pty] == nil { names[pty] = record }
        }
        // 立即用新名字重算一次，避免等下一轮轮询
        if unknown.contains(where: { names[$0] != nil }) { await refresh() }
    }

    nonisolated private static func capture<T: Sendable>(_ body: @Sendable () async throws -> T) async -> Result<T, any Error> {
        do { return .success(try await body()) } catch { return .failure(error) }
    }
}
