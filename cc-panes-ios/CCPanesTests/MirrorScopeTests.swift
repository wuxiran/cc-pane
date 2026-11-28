import XCTest
@testable import CCPanes

final class MirrorScopeTests: XCTestCase {
    private func group(_ computer: String, _ layout: String, current: Bool = false, waiting: Int = 0) -> MirrorGroup {
        let cards = (0..<max(1, waiting)).map { i in
            MirrorCard(sessionId: "\(computer)-\(layout)-\(i)", title: layout,
                       info: SessionInfo(sessionId: "\(computer)-\(layout)-\(i)", status: waiting > 0 ? "waitingInput" : "idle"))
        }
        return MirrorGroup(kind: .layout, title: layout, cards: cards, layoutId: layout, isCurrentLayout: current,
                           computerId: computer, computerName: computer)
    }

    private lazy var computers: [MirrorComputer] = [
        MirrorComputer(id: "mac", name: "MacBook", groups: [group("mac", "cc-pane", current: true, waiting: 2),
                                                            group("mac", "api"), group("mac", "notes")],
                       savedAt: Date(timeIntervalSince1970: 100)),
        MirrorComputer(id: "win", name: "Windows 工作站", groups: [group("win", "game", current: true), group("win", "wsl")]),
        MirrorComputer(id: "nas", name: "build-nas", groups: [], isOnline: false),
    ]

    func testAutoFocusPicksFirstLayoutOrDebugName() {
        let auto = resolveMirrorScope(MirrorScope(), computers: computers)
        XCTAssertNil(auto.computerId)
        XCTAssertEqual(auto.layout?.id, "mac|layout:cc-pane")
        let named = resolveMirrorScope(MirrorScope(), computers: computers, preferredLayoutName: "wsl")
        XCTAssertEqual(named.layout?.id, "win|layout:wsl")
        // 名字找不到 → 仍回落第一个
        XCTAssertEqual(resolveMirrorScope(MirrorScope(), computers: computers, preferredLayoutName: "nope").layout?.id,
                       "mac|layout:cc-pane")
    }

    func testStaleSelectionsFallBack() {
        // 布局被删：回落到范围内第一个（桌面当前）
        let deleted = resolveMirrorScope(MirrorScope(computerId: "win", focus: .layout("win|layout:gone")), computers: computers)
        XCTAssertEqual(deleted.computerId, "win")
        XCTAssertEqual(deleted.layout?.id, "win|layout:game")
        // 电脑被移除：回到全部电脑
        let removed = resolveMirrorScope(MirrorScope(computerId: "old", focus: .all), computers: computers)
        XCTAssertNil(removed.computerId)
        XCTAssertTrue(removed.isAll)
        XCTAssertEqual(removed.groups.count, 5)
    }

    func testPagingOrderAndLabel() {
        let all = resolveMirrorScope(MirrorScope(focus: .layout("mac|layout:notes")), computers: computers)
        XCTAssertEqual(all.pageIds, [nil, "mac|layout:cc-pane", "mac|layout:api", "mac|layout:notes",
                                     "win|layout:game", "win|layout:wsl"])
        XCTAssertEqual(all.pageLabel, "3/5")

        let win = resolveMirrorScope(MirrorScope(computerId: "win", focus: .layout("win|layout:wsl")), computers: computers)
        XCTAssertEqual(win.pageIds, [nil, "win|layout:game", "win|layout:wsl"])
        XCTAssertEqual(win.pageLabel, "2/2")

        // 全部页无页码；只有一个布局时不加「全部」页
        XCTAssertNil(resolveMirrorScope(.computer("mac"), computers: computers).pageLabel)
        let single = [MirrorComputer(id: "mac", name: "Mac", groups: [group("mac", "only")])]
        let one = resolveMirrorScope(MirrorScope(), computers: single)
        XCTAssertEqual(one.pageIds, ["mac|layout:only"])
        XCTAssertNil(one.pageLabel)
        XCTAssertEqual(resolveMirrorScope(MirrorScope(), computers: []).pageIds, [])
    }

    func testPagingKeepsComputerScope() {
        let scope = MirrorScope(computerId: "win", focus: .layout("win|layout:game"))
        XCTAssertEqual(scope.paging(to: "win|layout:wsl"), MirrorScope(computerId: "win", focus: .layout("win|layout:wsl")))
        XCTAssertEqual(scope.paging(to: nil), .computer("win"))
    }

    func testSelectionsFromPicker() {
        let wsl = computers[1].groups[1]
        // 按布局：限定的是别的电脑 → 回全部电脑；同一台 → 保留限定
        XCTAssertEqual(MirrorScope.computer("mac").selectingLayout(wsl), MirrorScope(computerId: nil, focus: .layout(wsl.id)))
        XCTAssertEqual(MirrorScope.computer("win").selectingLayout(wsl), MirrorScope(computerId: "win", focus: .layout(wsl.id)))
        // 按电脑：展开后选布局 → 限定到该电脑；点电脑行 → 该电脑全部布局
        XCTAssertEqual(MirrorScope.layout(wsl, onComputer: true), MirrorScope(computerId: "win", focus: .layout(wsl.id)))
        let computerScope = resolveMirrorScope(.computer("win"), computers: computers)
        XCTAssertTrue(computerScope.isAll)
        XCTAssertEqual(computerScope.groups.map(\.title), ["game", "wsl"])
        XCTAssertEqual(resolveMirrorScope(.everything, computers: computers).groups.count, 5)
    }

    func testHeaderTexts() {
        let layout = resolveMirrorScope(MirrorScope(), computers: computers)
        let h1 = mirrorHeader(layout, computers: computers)
        XCTAssertEqual(h1.title, "cc-pane")
        XCTAssertEqual(h1.subtitle, "桌面当前 · MacBook · 2 会话")
        XCTAssertEqual(h1.savedAt, Date(timeIntervalSince1970: 100))

        let all = mirrorHeader(resolveMirrorScope(.everything, computers: computers), computers: computers)
        XCTAssertEqual(all, MirrorHeader(title: "全部会话", subtitle: "全部电脑 · 5 个布局", savedAt: nil))

        let win = mirrorHeader(resolveMirrorScope(.computer("win"), computers: computers), computers: computers)
        XCTAssertEqual(win.title, "Windows 工作站")
        XCTAssertEqual(win.subtitle, "全部布局 · 2 会话")
    }

    func testSearchFiltersLayoutsAndComputers() {
        XCTAssertEqual(filterMirrorComputers(computers, query: "  ").count, 3)
        // 布局名命中：只留命中的布局，丢掉没命中的电脑
        let api = filterMirrorComputers(computers, query: "API")
        XCTAssertEqual(api.map(\.id), ["mac"])
        XCTAssertEqual(api.first?.groups.map(\.title), ["api"])
        // 电脑名命中：保留其全部布局（含无布局的离线电脑）
        XCTAssertEqual(filterMirrorComputers(computers, query: "windows").first?.groups.count, 2)
        XCTAssertEqual(filterMirrorComputers(computers, query: "nas").map(\.id), ["nas"])
        XCTAssertTrue(filterMirrorComputers(computers, query: "zzz").isEmpty)
    }

    func testCompactSummary() {
        XCTAssertEqual(PhaseCounts([.running, .waiting, .running, .running]).compactSummary, "4 会话 · 1 等待 · 3 运行")
        XCTAssertEqual(PhaseCounts([.idle, .exited]).compactSummary, "2 会话 · 1 空闲 · 1 结束")
        XCTAssertEqual(PhaseCounts().compactSummary, "0 会话")
    }

    func testComputerAggregates() {
        XCTAssertEqual(computers[0].sessionCount, 4)
        XCTAssertEqual(computers[0].waitingCount, 2)
        XCTAssertEqual(computers[2].sessionCount, 0)
    }
}
