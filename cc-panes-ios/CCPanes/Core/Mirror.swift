import Foundation

/// 桌面端 0.12.11 起按布局空间保存快照，单布局下固定为这个 profileId
/// （web/hooks/useSessionLayoutPersistence.ts::currentLayoutProfileId）。
let scopedLayoutProfileId = "layout-scope.workspace.default"
/// 0.12.11 之前桌面端写的 profileId；升级后不再更新，只留作旧版桌面兼容。
let legacyLayoutProfileId = "default"

enum MirrorConfig {
    /// savedAt 距今超过此值 → 「数据陈旧」（桌面每 60s 兜底保存 + 变更 800ms 保存）。
    static let snapshotStale: TimeInterval = 90
    /// 无布局归属且 updatedAt 超此值的会话视为残留，隐藏。
    static let orphanStale: TimeInterval = 5 * 60
    static let pollInterval: Duration = .seconds(5)
}

/// 在新旧两份快照结果里选当前生效的一份：两份都有取 savedAt 较新者；
/// 只有一份成功就用它；都失败返回新 id 的错误。只读旧 id 会拿到升级前停更的陈旧快照。
func pickCurrentSnapshot(
    scoped: Result<LayoutSnapshot?, any Error>,
    legacy: Result<LayoutSnapshot?, any Error>
) -> Result<LayoutSnapshot?, any Error> {
    // try? 会压平 Optional：失败与「成功但无快照」都得到 nil
    let a: LayoutSnapshot? = try? scoped.get()
    let b: LayoutSnapshot? = try? legacy.get()
    let legacyFailed = if case .failure = legacy { true } else { false }
    guard let a else {
        // 新 id 无值：旧 id 也失败则返回新 id 的结果（错误或空），否则用旧 id
        return legacyFailed ? scoped : .success(b)
    }
    guard let b else { return .success(a) }
    guard let aTime = a.savedAtDate, let bTime = b.savedAtDate else {
        return .success(a.savedAtDate == nil ? b : a)
    }
    return .success(bTime > aTime ? b : a)
}

/// 规范化项目路径，用于跨来源相等比较：去 `\\?\` / `//?/` 前缀 → 反斜杠转正斜杠 → 小写 → 去尾斜杠。
func normalizeProjectPath(_ path: String) -> String {
    var s = path.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.hasPrefix(#"\\?\"#) { s.removeFirst(4) }
    s = s.replacingOccurrences(of: "\\", with: "/")
    if s.hasPrefix("//?/") { s.removeFirst(4) }
    s = s.lowercased()
    while s.count > 1, s.hasSuffix("/") { s.removeLast() }
    return s
}

/// 从布局树提取的一张会话卡（一个终端 leaf = 一张卡）。
struct SessionCard: Equatable, Sendable {
    var sessionId: String
    var title: String
    var projectPath: String
    var cliTool: String?
    var layoutId: String
    var layoutName: String
    var isCurrentLayout: Bool
    /// pane 在所属布局里的序号（1-based），卡片显示 "Pane N"。
    var paneOrdinal: Int
    /// 该 leaf 是否是 tab 当前聚焦的终端分屏。
    var isActiveLeaf: Bool

    var projectName: String { pathBasename(projectPath) }
}

/// 递归收集 rootPane 下所有 Panel（左→右/上→下顺序）。
func collectPanels(_ node: PaneNode?) -> [(id: String, activeTabId: String?, tabs: [LayoutTab])] {
    switch node {
    case .panel(let id, let activeTabId, let tabs): [(id, activeTabId, tabs)]
    case .split(let children): children.flatMap(collectPanels)
    case nil: []
    }
}

func collectTerminalLeaves(_ node: TerminalNode?) -> [TerminalLeaf] {
    switch node {
    case .leaf(let leaf): [leaf]
    case .split(let children): children.flatMap(collectTerminalLeaves)
    case nil: []
    }
}

/// 把布局树拍平成会话卡：只处理 terminal tab；有 terminalRootPane 取各 leaf，
/// 否则回落 tab 顶层 sessionId；全局按 sessionId 去重（星标布局是镜像，会重复出现）。
func collectSessionCards(_ snapshot: LayoutSnapshot) -> [SessionCard] {
    var cards: [SessionCard] = []
    var seen = Set<String>()
    for layout in snapshot.layouts {
        for (index, panel) in collectPanels(layout.rootPane).enumerated() {
            for tab in panel.tabs where tab.isTerminal {
                for (sid, cli, active) in terminalSessions(of: tab, panelActiveTabId: panel.activeTabId)
                where seen.insert(sid).inserted {
                    cards.append(SessionCard(
                        sessionId: sid,
                        title: tab.title.isEmpty ? pathBasename(tab.projectPath) : tab.title,
                        projectPath: tab.projectPath,
                        cliTool: cli,
                        layoutId: layout.id,
                        layoutName: layout.name,
                        isCurrentLayout: layout.id == snapshot.currentLayoutId,
                        paneOrdinal: index + 1,
                        isActiveLeaf: active))
                }
            }
        }
    }
    return cards
}

/// 一个 terminal tab 里的 (sessionId, cliTool, 是否聚焦)。
private func terminalSessions(of tab: LayoutTab, panelActiveTabId: String?) -> [(String, String?, Bool)] {
    let leaves = collectTerminalLeaves(tab.terminalRootPane)
    if !leaves.isEmpty {
        return leaves.compactMap { leaf in
            // 单 leaf 的 tab「聚焦」恒为真，不标「当前」（Flutter 版会每张卡都标）
            leaf.effectiveSessionId.map {
                ($0, leaf.cliTool ?? tab.cliTool, leaves.count > 1 && leaf.id == tab.activeTerminalPaneId)
            }
        }
    }
    // 无 terminalRootPane 的旧/最小快照：回落 tab 顶层
    guard let sid = nonEmpty(tab.sessionId) ?? nonEmpty(tab.savedSessionId) else { return [] }
    return [(sid, tab.cliTool, tab.id == panelActiveTabId)]
}
