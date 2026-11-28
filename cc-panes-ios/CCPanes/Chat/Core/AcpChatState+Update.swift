import Foundation

/// `kind=update`：ACP `session/update` params 原样透传，按 `update.sessionUpdate` 分派。
extension AcpChatState {
    mutating func applyUpdate(_ payload: JSONValue) {
        let update = payload["update"] ?? .null
        guard let variant = update["sessionUpdate"]?.string else { return }
        let parent = update["_meta"]?["claudeCode"]?["parentToolUseId"]?.string
        switch variant {
        case "agent_message_chunk": appendChunk(update["content"], assistant: true, parent: parent)
        case "agent_thought_chunk": appendChunk(update["content"], assistant: false, parent: parent)
        case "user_message_chunk": appendUserChunk(update["content"])
        case "tool_call", "tool_call_update": upsertToolCall(update, parent: parent)
        case "plan":
            let entries = (update["entries"]?.array ?? []).compactMap { e -> AcpPlanEntry? in
                guard let content = e["content"]?.string else { return nil }
                return AcpPlanEntry(content: content, priority: e["priority"]?.string, status: e["status"]?.string)
            }
            upsertPlan(entries)
        case "available_commands_update":
            availableCommands = (update["availableCommands"]?.array ?? []).compactMap { $0["name"]?.string }
        case "current_mode_update":
            if let mode = update["currentModeId"]?.string { snapshot?.setCurrentMode(mode) }
        case "usage_update":
            guard let used = update["used"]?.int, let size = update["size"]?.int, size > 0 else { return }
            usage = AcpUsage(used: max(0, used), size: size)
        case "session_info_update", "config_option_update":
            return // 标题 / 配置项由后端写进快照与历史 meta，不是对话内容
        default:
            // 未知变体保持可见（v1→v2 协议漂移探针），同类只提示一次。
            pushOnce("[ACP] 未渲染的更新类型: \(variant)")
        }
    }

    /// 从 ContentBlock 提取可显示文本；非 text 变体降级为类型占位。
    static func contentText(_ block: JSONValue?) -> String {
        guard let block else { return "" }
        if let text = block["text"]?.string { return text }
        return block["type"]?.string.map { "[\($0)]" } ?? ""
    }

    private mutating func appendChunk(_ block: JSONValue?, assistant: Bool, parent: String?) {
        if block?["type"]?.string == "image" {
            push(.image(mimeType: block?["mimeType"]?.string ?? "image/png"), parent: parent)
            return
        }
        let text = Self.contentText(block)
        guard !text.isEmpty else { return }
        var appended = false
        mutateContent { items in
            guard let last = items.indices.last, items[last].parentToolCallId == parent else { return }
            switch (items[last].kind, assistant) {
            case (.assistant(let existing), true):
                items[last].kind = .assistant(existing + text)
                appended = true
            case (.thought(let existing, false), false):
                items[last].kind = .thought(existing + text, done: false)
                appended = true
            default:
                break
            }
        }
        if !appended { push(assistant ? .assistant(text) : .thought(text, done: false), parent: parent) }
    }

    /// 用户消息回显：先抵消本地乐观插入的同文本（避免重复气泡），
    /// 其余（桌面端发出的 prompt、session/load 历史回放）按正常用户气泡收下。
    private mutating func appendUserChunk(_ block: JSONValue?) {
        var text = Self.contentText(block)
        guard !text.isEmpty else { return }
        if replay == nil, let i = items.lastIndex(where: { ($0.echoRemaining ?? "").isEmpty == false }) {
            let remaining = items[i].echoRemaining!
            if remaining.hasPrefix(text) {
                items[i].echoRemaining = String(remaining.dropFirst(text.count))
                return
            }
            if text.hasPrefix(remaining) {
                items[i].echoRemaining = ""
                text = String(text.dropFirst(remaining.count))
                if text.isEmpty { return }
            }
        }
        var appended = false
        mutateContent { items in
            guard let last = items.indices.last, case .user(let existing) = items[last].kind,
                  items[last].echoRemaining == nil else { return }
            items[last].kind = .user(existing + text)
            appended = true
        }
        if !appended { push(.user(text)) }
    }

    private mutating func upsertToolCall(_ update: JSONValue, parent: String?) {
        guard let id = update["toolCallId"]?.string else { return }
        var merged = false
        mutateContent { items in
            for i in items.indices.reversed() {
                if case .toolCall(var call) = items[i].kind, call.toolCallId == id {
                    call.merge(update)
                    items[i].kind = .toolCall(call)
                    merged = true
                    return
                }
            }
        }
        guard !merged else { return }
        // 没见过 tool_call 就来 update：按 ACP 容错语义当作新卡片。
        var call = AcpToolCall(toolCallId: id)
        call.merge(update)
        push(.toolCall(call), parent: parent)
    }

    /// plan 整表替换最近一张 plan 卡；没有则新建。
    private mutating func upsertPlan(_ entries: [AcpPlanEntry]) {
        var replaced = false
        mutateContent { items in
            if let i = items.lastIndex(where: { if case .plan = $0.kind { true } else { false } }) {
                items[i].kind = .plan(entries)
                replaced = true
            }
        }
        if !replaced { push(.plan(entries)) }
    }
}
