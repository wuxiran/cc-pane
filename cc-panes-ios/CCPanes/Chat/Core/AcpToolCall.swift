import Foundation

/// tool_call / tool_call_update 的合并视图（按 toolCallId 就地更新）。
struct AcpToolCall: Sendable, Equatable {
    var toolCallId: String
    var title: String?
    var kind: String?
    var status: String?
    /// ACP ToolCallContent 数组：`content`（内嵌 ContentBlock）/ `diff` / `terminal`。
    var content: [JSONValue] = []
    var locations: [String] = []
    var rawInput: JSONValue?
    var rawOutput: JSONValue?

    /// 按 ACP 语义合并：标量非空即覆盖；content / locations 整表替换（不是追加）。
    mutating func merge(_ update: JSONValue) {
        if let t = update["title"]?.string { title = t }
        if let k = update["kind"]?.string { kind = k }
        if let s = update["status"]?.string { status = s }
        if let c = update["content"]?.array { content = c }
        if let l = update["locations"]?.array {
            locations = l.compactMap { loc in
                guard let path = loc["path"]?.string else { return nil }
                return loc["line"]?.int.map { "\(path):\($0)" } ?? path
            }
        }
        if let input = update["rawInput"], !input.isNull { rawInput = input }
        if let output = update["rawOutput"], !output.isNull { rawOutput = output }
    }

    var displayTitle: String {
        if let title, !title.isEmpty { return title }
        return kind.map(Self.kindLabel) ?? "工具调用"
    }

    /// 卡片展开后显示的条目（纯文本化，供 UI 直接渲染）。
    var renderedContent: [ToolContentPiece] {
        content.compactMap(ToolContentPiece.init)
    }

    static func kindLabel(_ kind: String) -> String {
        switch kind {
        case "read": "读取"
        case "edit": "编辑"
        case "delete": "删除"
        case "move": "移动"
        case "search": "搜索"
        case "execute": "执行"
        case "think": "思考"
        case "fetch": "联网"
        case "switch_mode": "切换模式"
        default: "其他"
        }
    }

    static func statusLabel(_ status: String?) -> String {
        switch status {
        case "pending": "等待中"
        case "in_progress": "进行中"
        case "completed": "已完成"
        case "failed": "失败"
        case nil: "等待中"
        case .some(let raw): raw
        }
    }
}

/// 工具卡展开区的一段内容。
enum ToolContentPiece: Sendable, Equatable {
    case text(String)
    case diff(path: String, oldText: String?, newText: String)
    case terminal(id: String)
    case unknown(String)

    init?(_ value: JSONValue) {
        switch value["type"]?.string {
        case "content":
            let block = value["content"] ?? .null
            if let text = block["text"]?.string { self = .text(text) }
            else { self = .unknown("[\(block["type"]?.string ?? "content")]") }
        case "diff":
            self = .diff(path: value["path"]?.string ?? "",
                         oldText: value["oldText"]?.string,
                         newText: value["newText"]?.string ?? "")
        case "terminal":
            guard let id = value["terminalId"]?.string else { return nil }
            self = .terminal(id: id)
        case .some(let type):
            self = .unknown("[\(type)]")
        case nil:
            return nil
        }
    }

    /// 简易行级 diff 文本：旧内容逐行 `-`、新内容逐行 `+`（移动端只读预览，不做 LCS）。
    static func diffLines(old: String?, new: String) -> [DiffLine] {
        let oldLines = old.map { $0.components(separatedBy: "\n") } ?? []
        let newLines = new.components(separatedBy: "\n")
        var common = 0
        while common < oldLines.count, common < newLines.count, oldLines[common] == newLines[common] { common += 1 }
        var lines: [DiffLine] = []
        if common > 0 { lines.append(.init(sign: " ", text: "…（\(common) 行未变）")) }
        lines += oldLines.dropFirst(common).map { DiffLine(sign: "-", text: $0) }
        lines += newLines.dropFirst(common).map { DiffLine(sign: "+", text: $0) }
        return lines
    }
}

struct DiffLine: Sendable, Equatable, Hashable {
    var sign: Character
    var text: String
}

/// 客户端 `terminal/*` 能力的输出快照（`terminal_output` 事件）。
struct AcpTerminalOutput: Sendable, Equatable {
    var terminalId: String
    var output: String
    var truncated: Bool
    var exitCode: Int?
}

/// plan 条目。
struct AcpPlanEntry: Sendable, Equatable, Hashable {
    var content: String
    var priority: String?
    var status: String?

    var statusSymbol: String {
        switch status {
        case "completed": "checkmark.circle.fill"
        case "in_progress": "circle.lefthalf.filled"
        default: "circle"
        }
    }
}
