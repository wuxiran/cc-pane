import Foundation

/// 对话流中的一条渲染条目。id 在条目生命期内稳定（流式续写不换 id）。
struct ChatItem: Sendable, Equatable, Identifiable {
    enum Kind: Sendable, Equatable {
        case user(String)
        case assistant(String)
        /// done：思考流已被后续条目或回合结束收口。
        case thought(String, done: Bool)
        case toolCall(AcpToolCall)
        case plan([AcpPlanEntry])
        case image(mimeType: String)
        case notice(String)
    }

    var id: String
    var kind: Kind
    /// 子 agent 归属（claude-agent-acp `_meta.claudeCode.parentToolUseId`）。
    var parentToolCallId: String?
    /// 本地乐观插入的用户消息：等待服务端 user_message_chunk 回显时要吞掉的剩余文本。
    var echoRemaining: String?
    /// 用户消息的 promptId（本机发送时生成；远端来的取自 `user_prompt`）。
    var promptId: String? = nil
    /// 发起方（`user_prompt.origin`）；本机发送为 "mobile"。
    var origin: String? = nil
    /// 本机发送、尚未收到服务端 `user_prompt` 确认。
    var promptPending = false
}

struct PermissionOption: Sendable, Equatable, Hashable, Identifiable {
    var optionId: String
    var name: String
    var kind: String
    var id: String { optionId }
    var isAllow: Bool { kind.hasPrefix("allow") }
}

/// `permission_request` 待处理审批。
struct PendingPermission: Sendable, Equatable, Identifiable {
    var requestKey: String
    var title: String
    var toolKind: String?
    var toolCallId: String?
    var detail: String?
    var options: [PermissionOption]
    var responding = false
    var error: String?

    var id: String { requestKey }

    init(requestKey: String, params: JSONValue) {
        self.requestKey = requestKey
        let call = params["toolCall"] ?? .null
        title = call["title"]?.string ?? "工具调用请求授权"
        toolKind = call["kind"]?.string
        toolCallId = call["toolCallId"]?.string
        detail = Self.detail(of: call)
        options = (params["options"]?.array ?? []).compactMap { o in
            guard let id = o["optionId"]?.string else { return nil }
            return PermissionOption(optionId: id, name: o["name"]?.string ?? id, kind: o["kind"]?.string ?? "")
        }
    }

    /// 卡片副标题：rawInput.command / path，其次 locations。
    private static func detail(of call: JSONValue) -> String? {
        let input = call["rawInput"] ?? .null
        for key in ["command", "cmd", "file_path", "path", "url"] {
            if let s = input[key]?.string { return s }
            if let a = input[key]?.array { return a.compactMap(\.string).joined(separator: " ") }
        }
        return call["locations"]?.array?.first?["path"]?.string
    }
}

/// `elicitation_request` 待回答的提问。
struct PendingQuestion: Sendable, Equatable, Identifiable {
    var requestKey: String
    var message: String
    var form: QuestionForm
    var responding = false
    var error: String?

    var id: String { requestKey }

    init(requestKey: String, params: JSONValue) {
        self.requestKey = requestKey
        message = params["message"]?.string ?? ""
        form = QuestionForm.parse(mode: params["mode"]?.string, schema: params["requestedSchema"])
    }
}

/// 底部停靠卡：同一时刻只显示一张（先审批后提问，按到达顺序）。
enum DockedCard: Sendable, Equatable {
    case permission(PendingPermission)
    case question(PendingQuestion)
}

struct AcpUsage: Sendable, Equatable {
    var used: Int
    var size: Int
    var fraction: Double { size > 0 ? min(1, Double(used) / Double(size)) : 0 }
}
