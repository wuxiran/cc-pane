import Foundation

/// 进程内假后端（`-acpMock YES`）：每个 chat 一条带 seq 的事件环 + 订阅者，
/// 语义同契约 §3.4——补发 `seq > afterSeq` → `synchronized` → 实时。剧本按延时追加事件。
actor MockAcpService: AcpService {
    static let shared = MockAcpService()

    private struct Chat {
        var summary: AcpChatSummary
        var events: [AcpEvent] = []
        var subscribers: [UUID: AsyncStream<AcpFrame>.Continuation] = [:]
        var waiting: CheckedContinuation<Void, Never>?
        var waitingKey: String?
        var started = false
        var instant = false
        /// configOptions 当前值（configId → value）。
        var config: [String: String] = [:]
    }

    private var chats: [String: Chat] = [:]
    private let resolveAfter: Int

    init(defaults: UserDefaults = .standard) {
        resolveAfter = defaults.integer(forKey: "acpMockResolveAfter")
        let cwd = "/Users/dev/workspace/cc-pane"
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        chats["mock-live"] = Chat(summary: AcpChatSummary(
            chatId: "mock-live", engineId: "claude", cwd: cwd, title: "给 OutputSequencer 补 reset 测试",
            acpSessionId: "acp-mock-live", status: "generating", lastSeq: 0, origin: "desktop",
            updatedAt: now, pendingPermissions: 1))
        chats["mock-done"] = Chat(summary: AcpChatSummary(
            chatId: "mock-done", engineId: "codex", cwd: "/Users/dev/workspace/cc-panes-ios",
            title: "检查 iOS 重连退避", acpSessionId: "acp-mock-done", status: "ready", lastSeq: 0,
            origin: "mobile", updatedAt: now - 600_000), instant: true)
        chats["bot-reviewer"] = Chat(summary: AcpChatSummary(
            chatId: "bot-reviewer", engineId: "claude", cwd: "/Users/dev/workspace/cc-pane", title: "代码评审 Bot",
            acpSessionId: "acp-bot-reviewer", status: "ready", lastSeq: 0, origin: "bot",
            updatedAt: now - 1_200_000, pendingPermissions: 0, botId: "reviewer"), instant: true)
    }

    // MARK: - REST

    func engines() async throws -> [AcpEngineInfo] {
        [AcpEngineInfo(id: "claude", label: "Claude", available: true, requirement: "npx @zed-industries/claude-code-acp"),
         AcpEngineInfo(id: "codex", label: "Codex", available: true, requirement: "npx @zed-industries/codex-acp"),
         AcpEngineInfo(id: "gemini", label: "Gemini", available: false, requirement: "需要安装 gemini CLI")]
    }

    func chats() async throws -> [AcpChatSummary] {
        chats.values.map(\.summary).sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
    }

    func history() async throws -> [AcpHistoryEntry] {
        let day: Int64 = 86_400_000
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        return [AcpHistoryEntry(acpSessionId: "hist-1", engineId: "claude", cwd: "/Users/dev/workspace/cc-pane",
                                title: "重构 MirrorState 分组逻辑", createdAt: now - 2 * day, updatedAt: now - day),
                AcpHistoryEntry(acpSessionId: "hist-2", engineId: "gemini", cwd: "/Users/dev/notes",
                                title: "整理周报", createdAt: now - 5 * day, updatedAt: now - 4 * day)]
    }

    func create(engineId: String, cwd: String, resumeAcpSessionId: String?) async throws -> AcpChatSnapshot {
        let id = "mobile-\(UUID().uuidString.prefix(8).lowercased())"
        chats[id] = Chat(summary: AcpChatSummary(chatId: id, engineId: engineId, cwd: cwd, title: nil,
                                                 acpSessionId: "acp-\(id)", status: "ready", lastSeq: 0,
                                                 origin: "mobile", updatedAt: Int64(Date().timeIntervalSince1970 * 1000)))
        chats[id]?.started = true
        let state = MockAcpScript.state(id, engine: engineId, cwd: cwd, phase: "ready")
        append(id, kind: "state", payload: state)
        if resumeAcpSessionId != nil {
            append(id, kind: "notification", payload: .from(["method": "ccpanes/load-unsupported"]))
        }
        return AcpChatSnapshot(state)
    }

    func detail(chatId: String) async throws -> (AcpChatSnapshot, Int?) {
        guard let chat = chats[chatId] else { throw AcpError.other("对话不存在") }
        return (AcpChatSnapshot(stateOf(chatId, phase: chat.summary.status ?? "ready")), chat.events.last?.seq)
    }

    func prompt(chatId: String, text: String, promptId: String) async throws {
        guard let s = chats[chatId]?.summary else { throw AcpError.other("对话不存在") }
        run(chatId, MockAcpScript.reply(chatId: chatId, engine: s.engineId, cwd: s.cwd ?? "", prompt: text,
                                        promptId: promptId, config: chats[chatId]?.config ?? [:]))
    }

    func setConfigOption(chatId: String, configId: String, value: String) async throws {
        guard chats[chatId] != nil else { throw AcpError.other("对话不存在") }
        chats[chatId]?.config[configId] = value
        append(chatId, kind: "state", payload: stateOf(chatId, phase: chats[chatId]?.summary.status ?? "ready"))
    }

    private func stateOf(_ chatId: String, phase: String) -> JSONValue {
        guard let chat = chats[chatId] else { return .null }
        return MockAcpScript.state(chatId, engine: chat.summary.engineId, cwd: chat.summary.cwd ?? "",
                                   phase: phase, config: chat.config)
    }

    func cancel(chatId: String) async throws {
        append(chatId, kind: "turn_ended", payload: .from(["stopReason": "cancelled"]))
    }

    func setMode(chatId: String, modeId: String) async throws {
        append(chatId, kind: "update", payload: MockAcpScript.update(["sessionUpdate": "current_mode_update", "currentModeId": modeId]))
    }

    func setModel(chatId: String, modelId: String) async throws {}

    func respondPermission(chatId: String, requestKey: String, optionId: String?) async throws {
        try await Task.sleep(for: .milliseconds(250))
        resolve(chatId, requestKey: requestKey, optionId: optionId, by: "mobile")
    }

    func respondElicitation(chatId: String, requestKey: String, response: JSONValue) async throws {
        append(chatId, kind: "elicitation_resolved", payload: .from(["requestKey": requestKey, "by": "mobile"]))
    }

    func stop(chatId: String) async throws {
        guard chats[chatId] != nil else { return }
        append(chatId, kind: "state", payload: stateOf(chatId, phase: "exited"))
    }

    /// 通讯录 mock：Bot 首条消息按需拉起 `bot-{id}` 对话（同 BotService::ensure_started），再走普通剧本。
    func ensureBotChat(chatId: String, botId: String, engineId: String, cwd: String, title: String) {
        guard chats[chatId] == nil else { return }
        chats[chatId] = Chat(summary: AcpChatSummary(
            chatId: chatId, engineId: engineId, cwd: cwd, title: title, acpSessionId: "acp-\(chatId)",
            status: "ready", lastSeq: 0, origin: "bot", updatedAt: Int64(Date().timeIntervalSince1970 * 1000),
            pendingPermissions: 0, botId: botId), started: true, instant: true)
        append(chatId, kind: "state", payload: stateOf(chatId, phase: "ready"))
    }

    // MARK: - Stream

    func openStream(chatId: String, afterSeq: Int) async -> AsyncStream<AcpFrame> {
        let (stream, continuation) = AsyncStream<AcpFrame>.makeStream()
        guard var chat = chats[chatId] else {
            continuation.yield(.closed(status: 404))
            continuation.finish()
            return stream
        }
        for event in chat.events where event.seq > afterSeq { continuation.yield(.event(event)) }
        continuation.yield(.synchronized(lastSeq: chat.events.last?.seq ?? 0))
        let id = UUID()
        chat.subscribers[id] = continuation
        let shouldStart = !chat.started
        chat.started = true
        chats[chatId] = chat
        continuation.onTermination = { [weak self] _ in
            Task { await self?.unsubscribe(chatId, id) }
        }
        if shouldStart { startScript(chatId) }
        return stream
    }

    private func unsubscribe(_ chatId: String, _ id: UUID) {
        chats[chatId]?.subscribers[id] = nil
    }

    private func startScript(_ chatId: String) {
        guard let chat = chats[chatId] else { return }
        let s = chat.summary
        let steps = MockAcpScript.turn(chatId: chatId, engine: s.engineId, cwd: s.cwd ?? "",
                                       prompt: "帮我给 OutputSequencer 加一个 reset 的单元测试", delay: chat.instant ? 0 : 90)
        run(chatId, steps)
    }

    private func run(_ chatId: String, _ steps: [MockAcpScript.Step]) {
        Task {
            for step in steps {
                switch step {
                case .emit(let delayMs, let kind, let payload):
                    if delayMs > 0 { try? await Task.sleep(for: .milliseconds(delayMs)) }
                    append(chatId, kind: kind, payload: payload)
                case .awaitPermission(let key):
                    await waitPermission(chatId, key: key)
                }
            }
        }
    }

    private func waitPermission(_ chatId: String, key: String) async {
        if chats[chatId]?.instant == true {
            append(chatId, kind: "permission_resolved", payload: .from(["requestKey": key, "optionId": "allow", "by": "desktop"]))
            return
        }
        if resolveAfter > 0 {
            Task {
                try? await Task.sleep(for: .seconds(resolveAfter))
                resolve(chatId, requestKey: key, optionId: "allow", by: "desktop")
            }
        }
        await withCheckedContinuation { continuation in
            chats[chatId]?.waiting = continuation
            chats[chatId]?.waitingKey = key
        }
    }

    /// 审批完成（本机回复或模拟「电脑端已处理」）：广播 permission_resolved 并推进剧本。
    private func resolve(_ chatId: String, requestKey: String, optionId: String?, by: String) {
        guard let chat = chats[chatId], chat.waitingKey == requestKey, let waiting = chat.waiting else { return }
        chats[chatId]?.waiting = nil
        chats[chatId]?.waitingKey = nil
        chats[chatId]?.summary.pendingPermissions = 0
        var payload: [String: Any] = ["requestKey": requestKey, "by": by]
        if let optionId { payload["optionId"] = optionId }
        append(chatId, kind: "permission_resolved", payload: .from(payload))
        waiting.resume()
    }

    private func append(_ chatId: String, kind: String, payload: JSONValue) {
        guard var chat = chats[chatId] else { return }
        let event = AcpEvent(seq: (chat.events.last?.seq ?? 0) + 1, kind: kind, payload: payload)
        chat.events.append(event)
        chat.summary.lastSeq = event.seq
        if kind == "state", let phase = payload["phase"]?.string { chat.summary.status = phase }
        chats[chatId] = chat
        for continuation in chat.subscribers.values { continuation.yield(.event(event)) }
    }
}
