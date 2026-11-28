import Foundation

// 手机本地会话（docs/112 §6）：手机直连 LLM API，不需要电脑在线。
// 这里是纯数据：供应商元数据（不含密钥）、对话与消息。密钥只在 Keychain（LocalProviderStore）。

/// 手机能直连的协议。rawValue 与桌面导出接口的 `protocol` 字段一致。
enum LLMProtocol: String, Codable, Sendable, CaseIterable, Identifiable {
    /// Anthropic Messages API：`POST {base}/v1/messages`（SSE）。
    case anthropic
    /// OpenAI 兼容 Chat Completions：`POST {base}/chat/completions`（SSE）。
    case openaiChat = "openai_chat"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .anthropic: "Anthropic Messages"
        case .openaiChat: "OpenAI 兼容（Chat Completions）"
        }
    }

    var shortLabel: String {
        switch self {
        case .anthropic: "Anthropic"
        case .openaiChat: "OpenAI"
        }
    }

    /// 手动添加时的默认地址。
    var defaultBaseURL: String {
        switch self {
        case .anthropic: "https://api.anthropic.com"
        case .openaiChat: "https://api.openai.com/v1"
        }
    }
}

struct LocalModel: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var label: String?

    var displayName: String { (label?.isEmpty == false ? label : nil) ?? id }
}

/// 本机供应商元数据（`providers.json`）。**没有密钥字段**——密钥按 `id` 存 Keychain。
struct LocalProvider: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var name: String
    var kind: LLMProtocol
    var baseURL: String
    var models: [LocalModel]
    var defaultModelId: String?
    /// 来自哪台电脑（导入时记下电脑名；手动添加为 nil）。
    var sourceComputer: String?
    /// 桌面端的供应商 id：同一台电脑重复导入时按它覆盖而不是新增一条。
    var originId: String?
    var updatedAt: Date

    init(id: String = UUID().uuidString, name: String, kind: LLMProtocol, baseURL: String,
         models: [LocalModel] = [], defaultModelId: String? = nil,
         sourceComputer: String? = nil, originId: String? = nil, updatedAt: Date = .now) {
        self.id = id
        self.name = name
        self.kind = kind
        self.baseURL = baseURL
        self.models = models
        self.defaultModelId = defaultModelId
        self.sourceComputer = sourceComputer
        self.originId = originId
        self.updatedAt = updatedAt
    }

    /// 新对话默认用的模型：显式默认 → 第一条 → 空（需要用户填）。
    var preferredModelId: String? {
        if let id = defaultModelId, !id.isEmpty { return id }
        return models.first?.id
    }
}

struct LLMUsage: Codable, Hashable, Sendable {
    var inputTokens: Int?
    var outputTokens: Int?

    var isEmpty: Bool { inputTokens == nil && outputTokens == nil }

    /// 合并流里分批到达的用量（Anthropic：开头给输入、结尾给输出）。
    mutating func merge(input: Int?, output: Int?) {
        if let input { inputTokens = input }
        if let output { outputTokens = output }
    }
}

struct LocalMessage: Codable, Hashable, Sendable, Identifiable {
    enum Role: String, Codable, Sendable { case user, assistant }

    var id: String
    var role: Role
    var text: String
    var thinking: String?
    var createdAt: Date
    /// 实际应答的模型（服务端回报）。
    var model: String?
    var usage: LLMUsage?
    var stopReason: String?
    /// 失败原因（中文，已映射）；有值时 UI 显示错误条与「重试」。
    var error: String?
    /// 被用户停止。
    var cancelled: Bool?

    init(id: String = UUID().uuidString, role: Role, text: String, thinking: String? = nil,
         createdAt: Date = .now, model: String? = nil, usage: LLMUsage? = nil,
         stopReason: String? = nil, error: String? = nil, cancelled: Bool? = nil) {
        self.id = id
        self.role = role
        self.text = text
        self.thinking = thinking
        self.createdAt = createdAt
        self.model = model
        self.usage = usage
        self.stopReason = stopReason
        self.error = error
        self.cancelled = cancelled
    }
}

/// 一条本地对话（`chats/<id>.json`）。
struct LocalChat: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var title: String
    /// 用户改过名后不再按首条消息自动起标题。
    var titleIsCustom: Bool
    var providerId: String
    var modelId: String
    var systemPrompt: String?
    var createdAt: Date
    var updatedAt: Date
    var messages: [LocalMessage]

    static let untitled = "新对话"

    init(id: String = UUID().uuidString, providerId: String, modelId: String,
         systemPrompt: String? = nil, now: Date = .now) {
        self.id = id
        title = Self.untitled
        titleIsCustom = false
        self.providerId = providerId
        self.modelId = modelId
        self.systemPrompt = systemPrompt
        createdAt = now
        updatedAt = now
        messages = []
    }

    /// 首条用户消息 → 标题：取首个非空行，压缩空白，最多 24 个字符。
    static func autoTitle(from text: String) -> String {
        let line = text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty } ?? ""
        let collapsed = line.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard !collapsed.isEmpty else { return untitled }
        return collapsed.count > 24 ? String(collapsed.prefix(24)) + "…" : collapsed
    }

    /// 合计用量（所有助手消息）。
    var totalUsage: LLMUsage {
        messages.reduce(into: LLMUsage()) { total, message in
            guard let usage = message.usage else { return }
            if let input = usage.inputTokens { total.inputTokens = (total.inputTokens ?? 0) + input }
            if let output = usage.outputTokens { total.outputTokens = (total.outputTokens ?? 0) + output }
        }
    }

    var preview: String {
        guard let last = messages.last(where: { !$0.text.isEmpty }) else { return "" }
        return last.text.replacingOccurrences(of: "\n", with: " ").prefix(80).description
    }
}

/// 给合并后的「对话」列表用的一行：本机对话被当作一台伪电脑「本机 iPhone」。
struct LocalChatListItem: Identifiable, Hashable, Sendable {
    static let computerId = "local-iphone"
    static let computerName = "本机 iPhone"

    var id: String
    var title: String
    var preview: String
    var updatedAt: Date
    var providerName: String
    var modelId: String
    var isGenerating: Bool
    var hasError: Bool
    var computerId: String { Self.computerId }
    var computerName: String { Self.computerName }
}
