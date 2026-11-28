import Foundation

// 「终端」tab 的范围选择（纯逻辑，单测覆盖）：选哪台电脑 / 哪个布局、左右翻页顺序、标题文案、选择器搜索。
// 范围 = 电脑（nil = 全部电脑）+ 焦点（全部布局 / 某个布局 / 自动 = 桌面当前布局）。

/// 一台电脑的镜像（多电脑聚合后的输入）。groups 的 computerId 已填好。
struct MirrorComputer: Identifiable, Equatable, Sendable {
    var id: String
    var name: String
    var groups: [MirrorGroup]
    var isOnline = true
    /// 线路（局域网 / Tailscale…），无则 nil。
    var route: String?
    var savedAt: Date?

    var sessionCount: Int { groups.reduce(0) { $0 + $1.cards.count } }
    var waitingCount: Int { groups.reduce(0) { $0 + $1.counts.waiting } }
}

struct MirrorScope: Equatable, Sendable {
    enum Focus: Equatable, Sendable {
        /// 未主动选择：`-mirrorLayout` 指定的布局，否则第一个布局（桌面当前布局排在最前）。
        case auto
        /// 范围内全部布局（按布局分节）。
        case all
        /// 某个布局（MirrorGroup.id）。
        case layout(String)
    }

    /// nil = 全部电脑。
    var computerId: String?
    var focus: Focus = .auto

    /// 「全部会话」：全部电脑、全部布局。
    static let everything = MirrorScope(computerId: nil, focus: .all)

    /// 按电脑：那台电脑的全部布局。
    static func computer(_ id: String) -> MirrorScope { MirrorScope(computerId: id, focus: .all) }

    /// 「按布局」网格里选中布局：当前限定的电脑正好是该布局所在电脑就保留限定，否则回到全部电脑（便于跨电脑翻页）。
    func selectingLayout(_ group: MirrorGroup) -> MirrorScope {
        MirrorScope(computerId: computerId == group.computerId ? computerId : nil, focus: .layout(group.id))
    }

    /// 「按电脑」里展开后选中布局：限定到该电脑（翻页只在这台电脑的布局间）。
    static func layout(_ group: MirrorGroup, onComputer: Bool) -> MirrorScope {
        MirrorScope(computerId: onComputer ? group.computerId : nil, focus: .layout(group.id))
    }

    /// 翻到某页（nil = 全部页），电脑限定不变。
    func paging(to pageId: String?) -> MirrorScope {
        MirrorScope(computerId: computerId, focus: pageId.map(Focus.layout) ?? .all)
    }
}

/// 解析后的范围：失效的电脑 / 布局已回落。
struct ResolvedMirrorScope: Equatable, Sendable {
    /// 生效的电脑限定（nil = 全部电脑）。
    var computerId: String?
    /// 范围内的布局（即翻页顺序）。
    var groups: [MirrorGroup]
    /// 当前布局；nil = 「全部」页。
    var layout: MirrorGroup?

    var isAll: Bool { layout == nil }

    /// 左右翻页的页序：多于一个布局时首页为「全部」（nil），其后按桌面顺序；只有一个布局时就它一页。
    var pageIds: [String?] {
        groups.count > 1 ? [nil] + groups.map(\.id) : groups.map(\.id)
    }

    /// 「2/8」式页码（全部页 / 只有一个布局时为 nil）。
    var pageLabel: String? {
        guard groups.count > 1, let layout, let index = groups.firstIndex(where: { $0.id == layout.id }) else { return nil }
        return "\(index + 1)/\(groups.count)"
    }
}

func resolveMirrorScope(_ scope: MirrorScope, computers: [MirrorComputer],
                        preferredLayoutName: String? = nil) -> ResolvedMirrorScope {
    let computerId = scope.computerId.flatMap { id in computers.contains { $0.id == id } ? id : nil }
    let groups = computers.filter { computerId == nil || $0.id == computerId }.flatMap(\.groups)
    func automatic() -> MirrorGroup? {
        if let name = preferredLayoutName, let group = groups.first(where: { $0.title == name }) { return group }
        return groups.first
    }
    let layout: MirrorGroup? = switch scope.focus {
    case .all: nil
    case .auto: automatic()
    // 布局被删 / 会话全退：回落到桌面当前布局
    case .layout(let id): groups.first { $0.id == id } ?? automatic()
    }
    return ResolvedMirrorScope(computerId: computerId, groups: groups, layout: layout)
}

/// 顶部标题：布局名 / 电脑名 / 全部会话 + 副标题（同步时间由视图按秒追加）。
struct MirrorHeader: Equatable, Sendable {
    var title: String
    var subtitle: String
    /// 副标题后追加「同步于…」的时间点。
    var savedAt: Date?
}

func mirrorHeader(_ resolved: ResolvedMirrorScope, computers: [MirrorComputer]) -> MirrorHeader {
    func name(_ id: String) -> String { computers.first { $0.id == id }?.name ?? "电脑" }
    if let layout = resolved.layout {
        let computer = computers.first { $0.id == layout.computerId }
        return MirrorHeader(title: layout.title,
                            subtitle: (layout.isCurrentLayout ? "桌面当前 · " : "")
                                + "\(computer?.name ?? "电脑") · \(layout.cards.count) 会话",
                            savedAt: computer?.savedAt)
    }
    if let id = resolved.computerId, let computer = computers.first(where: { $0.id == id }) {
        return MirrorHeader(title: name(id),
                            subtitle: "全部布局 · \(computer.sessionCount) 会话",
                            savedAt: computer.savedAt)
    }
    if computers.count <= 1 {
        let computer = computers.first
        return MirrorHeader(title: "全部会话",
                            subtitle: "\(computer?.name ?? "电脑") · \(resolved.groups.count) 个布局",
                            savedAt: computer?.savedAt)
    }
    return MirrorHeader(title: "全部会话", subtitle: "全部电脑 · \(resolved.groups.count) 个布局", savedAt: nil)
}

/// 选择器搜索：电脑名命中 → 保留该电脑全部布局；否则只留名字命中的布局。空查询原样返回（含无布局的电脑）。
func filterMirrorComputers(_ computers: [MirrorComputer], query: String) -> [MirrorComputer] {
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !needle.isEmpty else { return computers }
    func hit(_ text: String) -> Bool { text.localizedCaseInsensitiveContains(needle) }
    return computers.compactMap { computer in
        if hit(computer.name) { return computer }
        var narrowed = computer
        narrowed.groups = computer.groups.filter { hit($0.title) }
        return narrowed.groups.isEmpty ? nil : narrowed
    }
}
