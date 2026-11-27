import XCTest
@testable import CCPanes

final class SnapshotPickTests: XCTestCase {
    private struct Boom: Error {}

    private func snap(_ savedAt: String?, name: String) -> LayoutSnapshot {
        LayoutSnapshot(savedAt: savedAt, workspaceName: name)
    }

    func testBothPresentPicksNewerSavedAt() throws {
        let scoped = snap("2026-11-27T06:00:00.000Z", name: "scoped")
        let legacy = snap("2026-09-18T14:02:25.756Z", name: "legacy")
        XCTAssertEqual(try pickCurrentSnapshot(scoped: .success(scoped), legacy: .success(legacy)).get()?.workspaceName, "scoped")
        XCTAssertEqual(try pickCurrentSnapshot(scoped: .success(legacy), legacy: .success(scoped)).get()?.workspaceName, "scoped")
    }

    func testOnlyOneSucceedsUsesIt() throws {
        let legacy = snap("2026-09-18T14:02:25Z", name: "legacy")
        XCTAssertEqual(try pickCurrentSnapshot(scoped: .failure(Boom()), legacy: .success(legacy)).get()?.workspaceName, "legacy")
        XCTAssertEqual(try pickCurrentSnapshot(scoped: .success(nil), legacy: .success(legacy)).get()?.workspaceName, "legacy")
        XCTAssertEqual(try pickCurrentSnapshot(scoped: .success(legacy), legacy: .failure(Boom())).get()?.workspaceName, "legacy")
    }

    func testBothFailReturnsScopedError() {
        let result = pickCurrentSnapshot(scoped: .failure(Boom()), legacy: .failure(Boom()))
        XCTAssertThrowsError(try result.get())
    }

    func testScopedEmptyLegacyFailedIsEmptyNotError() throws {
        XCTAssertNil(try pickCurrentSnapshot(scoped: .success(nil), legacy: .failure(Boom())).get())
    }

    func testMissingSavedAtPrefersTheOneWithTime() throws {
        let timed = snap("2026-11-27T06:00:00Z", name: "timed")
        let untimed = snap(nil, name: "untimed")
        XCTAssertEqual(try pickCurrentSnapshot(scoped: .success(untimed), legacy: .success(timed)).get()?.workspaceName, "timed")
        XCTAssertEqual(try pickCurrentSnapshot(scoped: .success(timed), legacy: .success(untimed)).get()?.workspaceName, "timed")
    }
}

final class LayoutSnapshotParsingTests: XCTestCase {
    func testParsesTreeAndToleratesJunk() throws {
        let json = """
        {"savedAt":"2026-11-27T06:11:17.622Z","workspaceName":"cc-pane","payload":{
          "currentLayoutId":"L2",
          "layouts":[
            "junk",
            {"id":"L1","name":"token","rootPane":{"id":"p1","tabs":[
              {"id":"t1","contentType":"terminal","title":"","projectPath":"/a/tokenhub","cliTool":"claude",
               "terminalRootPane":{"type":"leaf","id":"x","sessionId":null,"savedSessionId":"S-saved"}},
              {"id":"t2","contentType":"browser","title":"web","projectPath":"/a"}
            ]}},
            {"id":"L2","name":"ccpane","rootPane":{"type":"split","children":[
              {"type":"panel","id":"p1","tabs":[{"id":"t3","contentType":"terminal","title":"cc-pane (Claude)",
                "projectPath":"/w/cc-pane","activeTerminalPaneId":"leafB",
                "terminalRootPane":{"type":"split","children":[{"type":"leaf","id":"leafA","sessionId":"S1"},
                                                              {"type":"leaf","id":"leafB","sessionId":"S2"}]}}]},
              {"type":"panel","id":"p2","activeTabId":"t4","tabs":[{"id":"t4","contentType":"terminal","title":"old",
                "projectPath":"C:\\\\w\\\\old","sessionId":"S3"}]}
            ]}}
          ]}}
        """
        let snapshot = try JSONDecoder().decode(LayoutSnapshot.self, from: Data(json.utf8))
        XCTAssertEqual(snapshot.layouts.count, 2)
        XCTAssertNotNil(snapshot.savedAtDate)

        let cards = collectSessionCards(snapshot)
        XCTAssertEqual(cards.map(\.sessionId), ["S-saved", "S1", "S2", "S3"])
        XCTAssertEqual(cards[0].title, "tokenhub") // 空标题回落项目名
        XCTAssertEqual(cards[0].cliTool, "claude")
        XCTAssertEqual(cards[2].paneOrdinal, 1)
        XCTAssertTrue(cards[2].isActiveLeaf)
        XCTAssertFalse(cards[1].isActiveLeaf)
        XCTAssertEqual(cards[3].paneOrdinal, 2)
        XCTAssertTrue(cards[3].isActiveLeaf) // 无 terminalRootPane：按 panel.activeTabId
        XCTAssertEqual(cards[3].projectName, "old")
        XCTAssertTrue(cards[1].isCurrentLayout)
    }

    func testNormalizeProjectPath() {
        XCTAssertEqual(normalizeProjectPath(#"\\?\C:\Work\Repo\"#), "c:/work/repo")
        XCTAssertEqual(normalizeProjectPath("/Users/me/Repo/"), "/users/me/repo")
        XCTAssertEqual(normalizeProjectPath("/"), "/")
    }
}

final class MirrorStateTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 2_000_000_000)

    private func info(_ id: String, status: String = "idle", ageSeconds: Double = 0, exitCode: Int? = nil) -> SessionInfo {
        let ms = Int64((now.timeIntervalSince1970 - ageSeconds) * 1000)
        return SessionInfo(sessionId: id, status: status, lastOutputAt: ms, updatedAt: ms,
                           pid: nil, exitCode: exitCode, currentToolName: nil, currentToolSummary: nil, runtimeKind: nil)
    }

    private func leafTab(_ id: String, project: String, sessions: [String]) -> LayoutTab {
        let leaves = sessions.map { TerminalNode.leaf(TerminalLeaf(id: "leaf-\($0)", sessionId: $0)) }
        return LayoutTab(id: id, title: "", projectPath: project, terminalRootPane: .split(leaves))
    }

    private func snapshot(savedAgo: Double = 5) -> LayoutSnapshot {
        let savedAt = ISO8601DateFormatter().string(from: now.addingTimeInterval(-savedAgo))
        let other = LayoutEntry(id: "L1", name: "其他", rootPane: .panel(id: "p", activeTabId: nil,
            tabs: [leafTab("t1", project: "/w/a", sessions: ["A", "GONE"])]))
        let current = LayoutEntry(id: "L2", name: "当前", rootPane: .split([
            .panel(id: "p1", activeTabId: nil, tabs: [leafTab("t2", project: "/w/b", sessions: ["B1"])]),
            .panel(id: "p2", activeTabId: nil, tabs: [leafTab("t3", project: "/W/B/", sessions: ["B2", "A"])]),
        ]))
        return LayoutSnapshot(currentLayoutId: "L2", layouts: [other, current], savedAt: savedAt, workspaceName: "ws")
    }

    func testLayoutGroupsJoinRunningAndPutCurrentFirst() {
        let running = ["A", "B1", "B2"].map { info($0) }
        let state = buildMirrorState(snapshot: snapshot(), running: running, localLaunches: [:], now: now)
        XCTAssertEqual(state.groups.map(\.title), ["当前", "其他"])
        XCTAssertTrue(state.groups[0].isCurrentLayout)
        XCTAssertEqual(state.groups[0].cards.map(\.sessionId), ["B1", "B2"]) // A 已在「其他」里出现过，去重
        XCTAssertEqual(state.groups[0].cards.map(\.paneOrdinal), [1, 2])
        XCTAssertEqual(state.groups[1].cards.map(\.sessionId), ["A"]) // GONE 不在活会话 → 跳过
        XCTAssertEqual(state.sessionCount, 3)
        XCTAssertEqual(state.desktopProjectCounts["/w/b"], 2)
        XCTAssertEqual(state.desktopProjectCounts["/w/a"], 1)
        XCTAssertFalse(state.stale)
        XCTAssertEqual(state.workspaceName, "ws")
    }

    func testOrphansFilterExitedAndStale() {
        let running = [info("A"), info("fresh"), info("old", ageSeconds: 600), info("dead", exitCode: 0),
                       info("exitedStatus", status: "exited")]
        let names = ["fresh": LaunchRecord(projectPath: "/w/named", ptySessionId: "fresh", cliTool: "codex")]
        let state = buildMirrorState(snapshot: snapshot(), running: running, localLaunches: [:], names: names, now: now)
        let orphan = state.groups.last
        XCTAssertEqual(orphan?.kind, .orphan)
        XCTAssertEqual(orphan?.cards.map(\.sessionId), ["fresh"])
        XCTAssertEqual(orphan?.cards.first?.title, "named")
        XCTAssertEqual(orphan?.cards.first?.cliTool, "codex")
        XCTAssertEqual(orphan?.cards.first?.orphanReason, "未在电脑布局中")
    }

    func testMobileLaunchesGroupedBeforeOrphansEvenIfOld() {
        let running = [info("M", ageSeconds: 3600), info("O")]
        let local = ["M": LocalLaunch(sessionId: "M", projectPath: "/w/Mobile", cliTool: "claude", title: nil)]
        let state = buildMirrorState(snapshot: nil, running: running, localLaunches: local, now: now)
        XCTAssertFalse(state.snapshotAvailable)
        XCTAssertEqual(state.groups.map(\.kind), [.mobileRemote, .orphan])
        XCTAssertEqual(state.groups[0].cards.first?.title, "Mobile")
        XCTAssertEqual(state.mobileProjectCounts["/w/mobile"], 1)
    }

    func testStaleSnapshotFlagged() {
        let state = buildMirrorState(snapshot: snapshot(savedAgo: 200), running: [], localLaunches: [:], now: now)
        XCTAssertTrue(state.stale)
        XCTAssertTrue(state.isEmpty)
        XCTAssertTrue(state.snapshotAvailable)
    }

    func testWorkspaceSortAndMetrics() throws {
        let json = """
        [{"name":"zeta","projects":[{"id":"1","path":"/a"}]},
         {"name":"alpha","hidden":true,"projects":[]},
         {"name":"pinned","pinned":true,"projects":[{"id":"2","path":"/b"},{"id":"3","path":"/c"}]},
         {"name":"gone","archivedAt":"2026-01-01","projects":[]}]
        """
        let list = WorkspacesModel.sorted(try JSONDecoder().decode([Workspace].self, from: Data(json.utf8)))
        XCTAssertEqual(list.map(\.name), ["pinned", "alpha", "zeta"])
        XCTAssertEqual(WorkspaceMetrics(list), WorkspaceMetrics(workspaces: 3, projects: 3, pinned: 1, hidden: 1))
    }
}
