import Foundation

/// GET /api/acp/engines 元素（Rust AcpEngineInfo）。
struct AcpEngineInfo: Decodable, Identifiable, Sendable, Hashable {
    var id: String
    var label: String
    var available: Bool
    var requirement: String
}

/// GET /api/acp/chats 元素：活会话摘要。字段尽量可缺失（后端并行开发中）。
struct AcpChatSummary: Decodable, Identifiable, Sendable, Hashable {
    var chatId: String
    var engineId: String
    var cwd: String?
    var title: String?
    var acpSessionId: String?
    /// 契约写作 `status`；按桌面 phase 口径（starting/ready/generating/exited/failed）理解。
    var status: String?
    var lastSeq: Int?
    /// desktop / mobile / bot（§3.3）。
    var origin: String?
    var updatedAt: Int64?
    /// 待审批数（tab 与行尾角标）。
    var pendingPermissions: Int?
    /// Bot 对话（`chatId = bot-{id}`）对应的 Bot id。
    var botId: String?

    var id: String { chatId }
    var isMobile: Bool { origin == "mobile" }
    var isBot: Bool { origin == "bot" || botId != nil || chatId.hasPrefix("bot-") }
    var displayTitle: String {
        if let title, !title.isEmpty { return title }
        return cwd.map(pathBasename) ?? chatId
    }
}

/// GET /api/acp/history 元素（list_acp_chat_history）。时间为 Unix 毫秒。
struct AcpHistoryEntry: Decodable, Identifiable, Sendable, Hashable {
    var acpSessionId: String
    var engineId: String
    var cwd: String
    var title: String
    var createdAt: Int64?
    var updatedAt: Int64?

    var id: String { acpSessionId }
    var updatedDate: Date? { updatedAt.map { Date(timeIntervalSince1970: Double($0) / 1000) } }
}

/// 会话进程相位（Rust AcpChatPhase）。未知值保留原文。
enum AcpChatPhase: Sendable, Equatable {
    case starting, ready, generating, exited, failed
    case other(String)

    init(_ raw: String?) {
        switch raw {
        case "starting": self = .starting
        case "ready": self = .ready
        case "generating": self = .generating
        case "exited": self = .exited
        case "failed": self = .failed
        default: self = .other(raw ?? "")
        }
    }

    var label: String {
        switch self {
        case .starting: "启动中"
        case .ready: "就绪"
        case .generating: "生成中"
        case .exited: "已结束"
        case .failed: "失败"
        case .other(let raw): raw.isEmpty ? "未知" : raw
        }
    }

    var isTerminal: Bool { self == .exited || self == .failed }
}

struct AcpChoice: Sendable, Equatable, Hashable, Identifiable {
    var id: String
    var name: String
}

/// ACP Session Config Option（快照 `configOptions` 元素）：只支持 select 型。
struct AcpConfigOption: Sendable, Equatable, Identifiable {
    var configId: String
    var name: String
    var category: String?
    var currentValue: String?
    var choices: [AcpChoice]
    var id: String { configId }

    init?(_ raw: JSONValue) {
        guard let id = raw["configId"]?.string, !id.isEmpty,
              (raw["type"]?.string ?? "select") == "select" else { return nil }
        let choices = (raw["options"]?.array ?? []).compactMap { o -> AcpChoice? in
            guard let value = o["value"]?.string else { return nil }
            return AcpChoice(id: value, name: o["name"]?.string ?? value)
        }
        guard !choices.isEmpty else { return nil }
        configId = id
        name = raw["name"]?.string ?? id
        category = raw["category"]?.string
        currentValue = raw["currentValue"]?.string
        self.choices = choices
    }
}

/// 来源标签：`user_prompt.origin`、`permission_resolved.by`、列表 origin 共用。
enum AcpOrigin {
    static func label(_ raw: String?) -> String {
        guard let raw, !raw.isEmpty else { return "其他端" }
        switch raw {
        case "desktop": return "电脑"
        case "mobile": return "手机"
        case "im": return "IM"
        case "bot": return "Bot"
        default:
            if raw.hasPrefix("device:") { return String(raw.dropFirst("device:".count)) }
            if raw.hasPrefix("bot:") { return "Bot \(raw.dropFirst("bot:".count))" }
            return raw
        }
    }
}

/// AcpChatSnapshot：按需从 JSON 取字段，保持对后端字段增减的容忍。
struct AcpChatSnapshot: Sendable, Equatable {
    var raw: JSONValue

    init(_ raw: JSONValue) { self.raw = raw }

    var chatId: String? { raw["chatId"]?.string }
    var engineId: String? { raw["engineId"]?.string }
    var acpSessionId: String? { raw["acpSessionId"]?.string }
    var cwd: String? { raw["cwd"]?.string }
    var title: String? { raw["title"]?.string }
    var phase: AcpChatPhase { AcpChatPhase(raw["phase"]?.string ?? raw["status"]?.string) }
    var error: String? { raw["error"]?.string }

    var currentModeId: String? { raw["modes"]?["currentModeId"]?.string }
    var modes: [AcpChoice] {
        (raw["modes"]?["availableModes"]?.array ?? []).compactMap { m in
            guard let id = m["id"]?.string else { return nil }
            return AcpChoice(id: id, name: m["name"]?.string ?? id)
        }
    }

    var currentModelId: String? { raw["models"]?["currentModelId"]?.string }
    var models: [AcpChoice] {
        (raw["models"]?["availableModels"]?.array ?? []).compactMap { m in
            guard let id = m["modelId"]?.string else { return nil }
            return AcpChoice(id: id, name: m["name"]?.string ?? id)
        }
    }

    /// select 型配置项；legacy modes / models 已渲染的类别不重复出现。
    var configOptions: [AcpConfigOption] {
        let hidden: Set<String> = Set([modes.isEmpty ? nil : "mode", models.isEmpty ? nil : "model"].compactMap { $0 })
        return (raw["configOptions"]?.array ?? []).compactMap(AcpConfigOption.init)
            .filter { !($0.category.map(hidden.contains) ?? false) }
    }

    /// 本地记录模式切换（current_mode_update），后端随后的 state 事件会覆盖。
    mutating func setCurrentMode(_ modeId: String) {
        guard case .object(var root) = raw else { return }
        var modes = root["modes"]?.object ?? [:]
        modes["currentModeId"] = .string(modeId)
        root["modes"] = .object(modes)
        raw = .object(root)
    }

    /// GET /api/acp/chats/{id} 与 POST /api/acp/chats 的响应：契约定为嵌套 `{snapshot, lastSeq}`；
    /// 仍兼容早期扁平形状（快照字段 + lastSeq）。
    static func parseDetail(_ value: JSONValue) -> (AcpChatSnapshot, Int?) {
        if let inner = value["snapshot"], inner.object != nil {
            return (AcpChatSnapshot(inner), value["lastSeq"]?.int)
        }
        return (AcpChatSnapshot(value), value["lastSeq"]?.int)
    }
}

/// 事件环中的一条事件（WS `event` 帧）。
struct AcpEvent: Sendable, Equatable {
    var seq: Int
    var kind: String
    var payload: JSONValue
}

/// /ws/acp/{chatId} 下行帧。
enum AcpFrame: Sendable, Equatable {
    case event(AcpEvent)
    case reset(snapshot: JSONValue, floorSeq: Int)
    case synchronized(lastSeq: Int)
    /// 连接关闭（含握手失败）；`status` 为握手 HTTP 状态码（若可得）。
    case closed(status: Int?)

    static func parse(_ data: Data) -> AcpFrame? {
        guard let value = try? JSONDecoder().decode(JSONValue.self, from: data),
              let type = value["type"]?.string else { return nil }
        switch type {
        case "event":
            guard let seq = value["seq"]?.int, let kind = value["kind"]?.string else { return nil }
            return .event(AcpEvent(seq: seq, kind: kind, payload: value["payload"] ?? .null))
        case "reset":
            return .reset(snapshot: value["snapshot"] ?? .null, floorSeq: value["floorSeq"]?.int ?? 0)
        case "synchronized":
            return .synchronized(lastSeq: value["lastSeq"]?.int ?? 0)
        default:
            return nil
        }
    }
}

/// 引擎 id → 显示名 / SF Symbol（内置 11 家；自定义引擎用通用图标）。
enum AcpEngineStyle {
    static func label(_ id: String, engines: [AcpEngineInfo] = []) -> String {
        if let e = engines.first(where: { $0.id == id }) { return e.label }
        switch id {
        case "claude": return "Claude"
        case "codex": return "Codex"
        case "gemini": return "Gemini"
        case "grok": return "Grok"
        case "qwen": return "Qwen"
        case "opencode": return "OpenCode"
        case "copilot": return "Copilot"
        case "cursor-agent": return "Cursor"
        case "kimi": return "Kimi"
        default: return id
        }
    }

    static func symbol(_ id: String) -> String {
        switch id {
        case "claude": "sparkles"
        case "codex": "chevron.left.forwardslash.chevron.right"
        case "gemini": "diamond"
        case "grok": "bolt"
        case "cursor-agent": "cursorarrow.rays"
        case "copilot": "airplane"
        case "opencode": "curlybraces"
        default: "bubble.left.and.text.bubble.right"
        }
    }
}
