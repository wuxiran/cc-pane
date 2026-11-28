import Foundation

// 「终端」tab 的纯展示逻辑（无 SwiftUI 依赖，单测覆盖）：布局几何、会话相位、输出预览降噪、标题清理。

/// 布局分屏几何（缩略图 / 布局地图用）。pane 序号与 `collectPanels` 顺序一致（1-based）。
indirect enum LayoutShape: Equatable, Sendable {
    case pane(ordinal: Int)
    case split(horizontal: Bool, children: [LayoutShape], weights: [Double])

    var paneCount: Int {
        switch self {
        case .pane: 1
        case .split(_, let children, _): children.reduce(0) { $0 + $1.paneCount }
        }
    }
}

/// PaneNode → LayoutShape；权重缺失或数量不符时等分。
func layoutShape(_ node: PaneNode?) -> LayoutShape? {
    var counter = 0
    return layoutShape(node, counter: &counter)
}

private func layoutShape(_ node: PaneNode?, counter: inout Int) -> LayoutShape? {
    switch node {
    case nil:
        return nil
    case .panel:
        counter += 1
        return .pane(ordinal: counter)
    case .split(let children, let horizontal, let sizes):
        let shapes = children.compactMap { layoutShape($0, counter: &counter) }
        guard !shapes.isEmpty else { return nil }
        if shapes.count == 1 { return shapes[0] }
        let valid = sizes.count == shapes.count && sizes.allSatisfy { $0 > 0 }
        return .split(horizontal: horizontal, children: shapes,
                      weights: valid ? sizes : Array(repeating: 1, count: shapes.count))
    }
}

/// 会话对用户而言的相位：等待输入 > 运行中 > 空闲 > 已退出（Comparable 即「紧急程度」）。
enum SessionPhase: Int, Comparable, Sendable, CaseIterable {
    case exited = 0, idle, running, waiting

    init(status: String, exited: Bool) {
        if exited { self = .exited; return }
        switch status {
        case "waitingInput": self = .waiting
        case "idle": self = .idle
        case "exited": self = .exited
        default: self = .running // initializing / active / thinking / toolRunning / compacting
        }
    }

    init(_ info: SessionInfo) { self.init(status: info.status, exited: info.exited) }

    static func < (a: SessionPhase, b: SessionPhase) -> Bool { a.rawValue < b.rawValue }
}

/// 各相位计数（布局切换卡上的汇总）。
struct PhaseCounts: Equatable, Sendable {
    var waiting = 0, running = 0, idle = 0, exited = 0

    init(_ phases: [SessionPhase] = []) {
        for phase in phases {
            switch phase {
            case .waiting: waiting += 1
            case .running: running += 1
            case .idle: idle += 1
            case .exited: exited += 1
            }
        }
    }

    var total: Int { waiting + running + idle + exited }
    /// 一行紧凑汇总：「4 会话 · 3 运行 · 1 等待」（0 项省略，紧急的在前）。
    var compactSummary: String {
        var parts = ["\(total) 会话"]
        if waiting > 0 { parts.append("\(waiting) 等待") }
        if running > 0 { parts.append("\(running) 运行") }
        if idle > 0 { parts.append("\(idle) 空闲") }
        if exited > 0 { parts.append("\(exited) 结束") }
        return parts.joined(separator: " · ")
    }
    /// 最紧急的相位（无会话为 nil）。
    var top: SessionPhase? {
        if waiting > 0 { return .waiting }
        if running > 0 { return .running }
        if idle > 0 { return .idle }
        return exited > 0 ? .exited : nil
    }
}

/// 去掉 tab 标题里冗余的 CLI 后缀：「cc-pane (Claude)」→「cc-pane」（CLI 已由图标表达）。
func cleanSessionTitle(_ title: String) -> String {
    let pattern = #"\s*\((claude|codex|gemini|grok|qwen|opencode|kimi|cursor|copilot)\)"#
    let cleaned = title.replacingOccurrences(of: pattern, with: "", options: [.regularExpression, .caseInsensitive])
        .trimmingCharacters(in: .whitespaces)
    return cleaned.isEmpty ? title : cleaned
}

/// 从终端最近 N 行里挑「有意义」的一段作预览：自底向上跳过 TUI 噪声（状态脚注、分隔线、空提示符、
/// 快捷键提示），取最后一段连续的有效行（最多 4 行）拼成一句。全是噪声返回 nil。
func meaningfulPreview(_ lines: [String]) -> String? {
    var block: [String] = []
    for raw in lines.reversed() {
        let line = cleanPreviewLine(raw)
        if let line {
            block.insert(line, at: 0)
            if block.count >= 4 { break }
        } else if !block.isEmpty {
            break // 一段结束
        }
    }
    guard !block.isEmpty else { return nil }
    let text = block.joined(separator: " ").replacingOccurrences(of: #"\s{2,}"#, with: " ", options: .regularExpression)
    return text.isEmpty ? nil : text
}

/// 噪声行返回 nil；有效行返回去掉装饰前缀后的文本。
func cleanPreviewLine(_ raw: String) -> String? {
    var line = raw.trimmingCharacters(in: .whitespaces)
    guard !line.isEmpty else { return nil }
    let lower = line.lowercased()
    if previewNoise.contains(where: { lower.contains($0) }) { return nil }
    // 纯框线 / 分隔线 / 孤立提示符
    let decorative = CharacterSet(charactersIn: "─━═—-_│┃|╭╮╰╯┌┐└┘├┤>❯›$%#·•⎿ ")
    if line.unicodeScalars.allSatisfy({ decorative.contains($0) }) { return nil }
    // 行首装饰：Claude 的 ⏺ / ※ recap: / ⎿；保留 ✻ 状态行的文字
    for prefix in ["⏺ ", "⎿ ", "※ recap:", "※ ", "✻ ", "✽ ", "✶ ", "✢ ", "· ", "❯ "] where line.hasPrefix(prefix) {
        line = String(line.dropFirst(prefix.count)).trimmingCharacters(in: .whitespaces)
    }
    line = line.replacingOccurrences(of: #"\(turn( off recaps in /config\))?$"#, with: "", options: .regularExpression)
        .trimmingCharacters(in: .whitespaces)
    return line.isEmpty ? nil : line
}

private let previewNoise: [String] = [
    "bypass permissions", "shift+tab to cycle", "esc to interrupt", "? for shortcuts", "/clear to save",
    "ctrl+b to run in background", "ctrl+o to expand", "enter to confirm", "accept edits on",
    "plan mode on", "auto-accept", "recaps in /config)", "press up to edit queued",
    "ctrl+t to show todos", "context left until auto-compact", "⏵⏵",
]
