import Foundation

#if DEBUG
/// 联调用的 DEBUG 启动参数（无 GUI 自动化的模拟器上驱动「手机端」）：
/// - `-acpAutoSend <text>`：对话首次 live 后自动发送一条 prompt（每次启动一次）
/// - `-acpAutoApprove <optionId|kind:allow_once|cancel>` + `-acpAutoApproveAfter N`：审批卡出现 N 秒后自动回复
/// - `-acpDropAfter N`：首次 live 后 N 秒模拟断线（走与真实断线相同的重连 + afterSeq 续传）
/// - `-acpCreate <engineId>|<cwd>`：「对话」tab 启动即新建并进入该对话
/// 另：每次合批后把 transcript 摘要写到 Documents/acp-debug-<chatId>.json，供 simctl 取证。
@MainActor
enum AcpDebugHooks {
    private static var autoSent = false
    private static var dropped = false

    static var defaults: UserDefaults { .standard }

    static func onLive(_ session: AcpChatSession) {
        if !autoSent, let text = defaults.string(forKey: "acpAutoSend"), !text.isEmpty {
            autoSent = true
            Task { await session.send(text) }
        }
        let dropAfter = defaults.integer(forKey: "acpDropAfter")
        if !dropped, dropAfter > 0 {
            dropped = true
            Task { [weak session] in
                try? await Task.sleep(for: .seconds(dropAfter))
                session?.debugSimulateDrop()
            }
        }
    }

    static func onPermission(_ session: AcpChatSession, requestKey: String) {
        guard let option = defaults.string(forKey: "acpAutoApprove"), !option.isEmpty else { return }
        let delay = max(0, defaults.integer(forKey: "acpAutoApproveAfter"))
        Task { [weak session] in
            try? await Task.sleep(for: .seconds(delay))
            // `kind:<allow_once|reject_once|…>` 按选项 kind 挑（真引擎的 optionId 不固定）。
            var chosen: String? = option == "cancel" ? nil : option
            if option.hasPrefix("kind:"), let session {
                let kind = String(option.dropFirst("kind:".count))
                chosen = session.state.pendingPermissions.first { $0.requestKey == requestKey }?
                    .options.first { $0.kind == kind }?.optionId
            }
            await session?.respondPermission(requestKey, optionId: chosen)
        }
    }

    static var createRequest: (engineId: String, cwd: String)? {
        guard let raw = defaults.string(forKey: "acpCreate"), let bar = raw.firstIndex(of: "|") else { return nil }
        return (String(raw[..<bar]), String(raw[raw.index(after: bar)...]))
    }

    static func dump(_ session: AcpChatSession) {
        let state = session.state
        let items: [[String: Any]] = state.items.map { item in
            var row: [String: Any] = ["id": item.id]
            switch item.kind {
            case .user(let t): row["user"] = t; row["promptId"] = item.promptId ?? ""; row["origin"] = item.origin ?? ""
            case .assistant(let t): row["assistant"] = t
            case .thought(let t, _): row["thought"] = t.count
            case .toolCall(let c): row["tool"] = c.toolCallId; row["status"] = c.status ?? ""
            case .plan(let e): row["plan"] = e.count
            case .image: row["image"] = true
            case .notice(let t): row["notice"] = t
            }
            return row
        }
        let summary: [String: Any] = [
            "chatId": session.chatId,
            "lastSeq": state.lastSeq,
            "synchronized": state.synchronized,
            "link": String(describing: session.link),
            "phase": state.phase.label,
            "pendingPermissions": state.pendingPermissions.map(\.requestKey),
            "configOptions": state.snapshot?.configOptions.map(\.configId) ?? [],
            "items": items,
        ]
        guard let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
              let data = try? JSONSerialization.data(withJSONObject: summary, options: [.prettyPrinted, .sortedKeys])
        else { return }
        let safe = session.chatId.replacingOccurrences(of: "/", with: "_")
        try? data.write(to: dir.appendingPathComponent("acp-debug-\(safe).json"))
    }
}
#endif
