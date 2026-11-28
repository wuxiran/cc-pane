import Foundation

enum MirrorGroupKind: Sendable, Equatable {
    case layout
    case mobileRemote
    case orphan
}

/// 一张镜像卡：布局里的一个终端 leaf / 手机远程会话 / 孤儿会话。
struct MirrorCard: Identifiable, Equatable, Sendable {
    var sessionId: String
    var title: String
    var info: SessionInfo
    var projectName: String?
    var cliTool: String?
    var paneOrdinal: Int?
    var isActiveLeaf = false
    var orphanReason: String?
    var projectPath: String?

    var id: String { sessionId }
    var phase: SessionPhase { SessionPhase(info) }
    /// 去掉 CLI 后缀的标题。
    var displayTitle: String { cleanSessionTitle(title) }
}

struct MirrorGroup: Identifiable, Equatable, Sendable {
    var kind: MirrorGroupKind
    var title: String
    var cards: [MirrorCard]
    var layoutId: String?
    var isCurrentLayout = false
    /// 布局分屏几何（仅布局组）。
    var shape: LayoutShape?
    /// 多电脑聚合时所属电脑（空 = 单电脑；参与 id 以免不同电脑的「手机远程会话」组撞 id）。
    var computerId = ""
    var computerName: String?

    var counts: PhaseCounts { PhaseCounts(cards.map(\.phase)) }
    /// 某 pane 内最紧急的相位（缩略图着色）；pane 内无活会话为 nil。
    func phase(ofPane ordinal: Int) -> SessionPhase? {
        cards.filter { $0.paneOrdinal == ordinal }.map(\.phase).max()
    }

    var id: String {
        let base = switch kind {
        case .layout: "layout:" + (layoutId ?? title)
        case .mobileRemote: "mobile"
        case .orphan: "orphan"
        }
        return computerId.isEmpty ? base : computerId + "|" + base
    }
}

/// 手机自己 launch 的会话元数据（进「手机远程会话」组）。
struct LocalLaunch: Sendable, Equatable {
    var sessionId: String
    var projectPath: String
    var workspaceName: String?
    var cliTool: String?
    var title: String?

    var displayTitle: String { nonEmpty(title) ?? pathBasename(projectPath) }
}

struct MirrorState: Equatable, Sendable {
    var groups: [MirrorGroup] = []
    /// 桌面前端是否落过快照（false = 电脑未运行/未开前端）。
    var snapshotAvailable = false
    /// 快照过旧：数据可能不反映电脑当前状态。
    var stale = false
    var savedAt: Date?
    var workspaceName: String?
    /// 规范化项目路径 → 电脑布局里该项目的活会话数（工作区 tab 标「电脑在跑 N」）。
    var desktopProjectCounts: [String: Int] = [:]
    /// 规范化项目路径 → 手机启动的活会话数（工作区 tab 标「手机打开」）。
    var mobileProjectCounts: [String: Int] = [:]

    var isEmpty: Bool { groups.isEmpty }
    var sessionCount: Int { groups.reduce(0) { $0 + $1.cards.count } }
    /// 等待输入的会话数（「终端」tab 角标）。
    var waitingCount: Int { groups.reduce(0) { $0 + $1.cards.filter { $0.phase == .waiting }.count } }
}

/// 合成镜像状态（纯函数）。
/// - 布局组：collectSessionCards join /api/sessions 活会话；当前布局提前，其余保持桌面顺序。
/// - 手机远程会话组：本机 launch 记录的会话（在 /api/sessions、不在布局）。
/// - 未归入布局（孤儿）：/api/sessions 有、不在布局也不是手机启动；过滤已退出与过旧残留。
///   `names` 用 launch-history 给孤儿起名（Flutter 版直接显示 sessionId）。
func buildMirrorState(
    snapshot: LayoutSnapshot?,
    running: [SessionInfo],
    localLaunches: [String: LocalLaunch],
    names: [String: LaunchRecord] = [:],
    now: Date
) -> MirrorState {
    let runningById = Dictionary(running.map { ($0.sessionId, $0) }, uniquingKeysWith: { a, _ in a })
    var state = MirrorState(snapshotAvailable: snapshot != nil, workspaceName: snapshot?.workspaceName)
    var inLayout = Set<String>()
    var desktopCounts: [String: Int] = [:]
    let groups = layoutGroups(snapshot: snapshot, runningById: runningById) { card in
        inLayout.insert(card.sessionId)
        if !card.projectPath.isEmpty {
            desktopCounts[normalizeProjectPath(card.projectPath), default: 0] += 1
        }
    }
    state.groups = groups
    state.desktopProjectCounts = desktopCounts

    var mobile: [MirrorCard] = []
    var orphans: [MirrorCard] = []
    for info in running where !inLayout.contains(info.sessionId) {
        if let meta = localLaunches[info.sessionId] {
            if !meta.projectPath.isEmpty {
                state.mobileProjectCounts[normalizeProjectPath(meta.projectPath), default: 0] += 1
            }
            mobile.append(MirrorCard(sessionId: info.sessionId, title: meta.displayTitle, info: info,
                                     projectName: pathBasename(meta.projectPath), cliTool: meta.cliTool,
                                     projectPath: meta.projectPath))
        } else if isLiveOrphan(info, now: now) {
            orphans.append(orphanCard(info, record: names[info.sessionId]))
        }
    }
    if !mobile.isEmpty { state.groups.append(MirrorGroup(kind: .mobileRemote, title: "手机远程会话", cards: mobile)) }
    if !orphans.isEmpty { state.groups.append(MirrorGroup(kind: .orphan, title: "未归入布局", cards: orphans)) }

    if let saved = snapshot?.savedAtDate {
        state.savedAt = saved
        state.stale = now.timeIntervalSince(saved) > MirrorConfig.snapshotStale
    }
    return state
}

/// 按布局分组（保持 collectSessionCards 顺序，当前布局提前）；快照有但已不在活会话的卡跳过。
private func layoutGroups(
    snapshot: LayoutSnapshot?,
    runningById: [String: SessionInfo],
    onCard: (SessionCard) -> Void
) -> [MirrorGroup] {
    guard let snapshot else { return [] }
    let shapes = Dictionary(snapshot.layouts.map { ($0.id, $0.rootPane) }, uniquingKeysWith: { a, _ in a })
    var groups: [MirrorGroup] = []
    var indexById: [String: Int] = [:]
    for card in collectSessionCards(snapshot) {
        guard let info = runningById[card.sessionId] else { continue }
        onCard(card)
        let mirror = MirrorCard(sessionId: card.sessionId, title: card.title, info: info,
                                projectName: card.projectName, cliTool: card.cliTool,
                                paneOrdinal: card.paneOrdinal, isActiveLeaf: card.isActiveLeaf,
                                projectPath: card.projectPath)
        if let i = indexById[card.layoutId] {
            groups[i].cards.append(mirror)
        } else {
            indexById[card.layoutId] = groups.count
            groups.append(MirrorGroup(kind: .layout, title: card.layoutName, cards: [mirror],
                                      layoutId: card.layoutId, isCurrentLayout: card.isCurrentLayout,
                                      shape: layoutShape(shapes[card.layoutId] ?? nil)))
        }
    }
    // 稳定排序：当前布局在前，其余保持插入顺序
    let current = groups.filter(\.isCurrentLayout)
    return current + groups.filter { !$0.isCurrentLayout }
}

private func isLiveOrphan(_ info: SessionInfo, now: Date) -> Bool {
    if info.exited { return false }
    let updatedMs = Double(info.updatedAt ?? 0)
    let ageSeconds = now.timeIntervalSince1970 - updatedMs / 1000
    return ageSeconds <= MirrorConfig.orphanStale
}

private func orphanCard(_ info: SessionInfo, record: LaunchRecord?) -> MirrorCard {
    let project = record?.projectPath.map(pathBasename) ?? record?.projectName
    return MirrorCard(sessionId: info.sessionId,
                      title: nonEmpty(project) ?? String(info.sessionId.prefix(8)),
                      info: info,
                      cliTool: record?.cliTool,
                      orphanReason: "未在电脑布局中",
                      projectPath: record?.projectPath)
}
