import XCTest
@testable import CCPanes

/// 首页外壳：多电脑命名 / 去重、统一搜索、底部状态条聚合、tab 初始值、连接退避。
final class HomeShellTests: XCTestCase {
    // MARK: - 命名

    func testSameHostReleaseAndDevGetDistinctNames() {
        var release = Computer(id: "r", name: "127.0.0.1", addresses: ["http://127.0.0.1:18080"])
        release.hostname = "wuxirandeMBP-6"
        release.isDevInstance = false
        var dev = Computer(id: "d", name: "127.0.0.1", addresses: ["http://127.0.0.1:18081"])
        dev.hostname = "wuxirandeMBP-6"
        dev.isDevInstance = true
        let names = ComputerNaming.displayNames([release, dev])
        XCTAssertEqual(names["r"], "wuxirandeMBP-6")
        XCTAssertEqual(names["d"], "wuxirandeMBP-6 · 开发版")
    }

    func testUnknownHostsFallBackToHostPortAndStayUnique() {
        let a = Computer(id: "a", name: "127.0.0.1", addresses: ["http://127.0.0.1:18080"])
        let b = Computer(id: "b", name: "127.0.0.1", addresses: ["http://127.0.0.1:18081"])
        let names = ComputerNaming.displayNames([a, b])
        XCTAssertEqual(names["a"], "127.0.0.1:18080")
        XCTAssertEqual(names["b"], "127.0.0.1:18081")
    }

    func testSameNameNoDevFlagGetsPortSuffix() {
        var a = Computer(id: "a", name: "", addresses: ["http://10.0.0.2:18080"])
        a.hostname = "mac"
        var b = Computer(id: "b", name: "", addresses: ["http://10.0.0.3:18090"])
        b.hostname = "mac"
        let names = ComputerNaming.displayNames([a, b])
        XCTAssertEqual(names["a"], "mac :18080")
        XCTAssertEqual(names["b"], "mac :18090")
    }

    func testUserNameWinsOverHostname() {
        var a = Computer(id: "a", name: "公司台式机", addresses: ["http://10.0.0.2:18080"])
        a.hostname = "DESKTOP-X"
        XCTAssertEqual(ComputerNaming.displayNames([a])["a"], "公司台式机")
        XCTAssertFalse(ComputerNaming.isAutoName(a))
    }

    func testDevDetectionFromDefaultCwd() {
        XCTAssertTrue(ComputerNaming.isDev(DeviceInfo(defaultCwd: "/Users/x/.cc-panes-dev")))
        XCTAssertFalse(ComputerNaming.isDev(DeviceInfo(defaultCwd: "/Users/x/.cc-panes")))
    }

    // MARK: - 去重

    func testDedupeMergesSameInstanceKeepingToken() {
        var lan = Computer(id: "lan", name: "192.168.1.2", addresses: ["http://192.168.1.2:18080"])
        lan.instanceId = "inst-1"
        var ts = Computer(id: "ts", name: "家里", addresses: ["http://100.70.0.1:18080"], tokenAccount: "ts")
        ts.instanceId = "inst-1"
        let other = Computer(id: "o", name: "o", addresses: ["http://10.0.0.9:18080"])
        let result = ComputerDedupe.merge([lan, other, ts])
        XCTAssertEqual(result.computers.map(\.id), ["lan", "o"])
        XCTAssertEqual(result.removed, ["ts"])
        XCTAssertEqual(result.computers[0].addresses, ["http://192.168.1.2:18080", "http://100.70.0.1:18080"])
        XCTAssertEqual(result.computers[0].tokenAccount, "ts", "带令牌的身份保留")
        XCTAssertEqual(result.computers[0].name, "家里", "用户起的名字保留")
    }

    func testDedupeIgnoresMissingInstanceId() {
        let a = Computer(id: "a", name: "a", addresses: ["http://127.0.0.1:18080"])
        let b = Computer(id: "b", name: "b", addresses: ["http://127.0.0.1:18081"])
        XCTAssertEqual(ComputerDedupe.merge([a, b]).computers.count, 2)
    }

    func testLegacyComputerDecodesAsKeepConnected() throws {
        let json = #"[{"id":"a","name":"n","addresses":["http://1.2.3.4:1"]}]"#
        let list = try JSONDecoder().decode([Computer].self, from: Data(json.utf8))
        XCTAssertTrue(list[0].isEnabled)
        XCTAssertNil(list[0].instanceId)
    }

    // MARK: - 统一搜索

    private let mac = UnifiedSearch.Tag(id: "m", name: "MacBook")
    private let pc = UnifiedSearch.Tag(id: "p", name: "台式机")

    private func chat(_ id: String, _ title: String, pending: Int = 0, session: String? = nil) -> AcpChatSummary {
        AcpChatSummary(chatId: id, engineId: "claude", cwd: "/w/\(title)", title: title, acpSessionId: session,
                       pendingPermissions: pending)
    }

    private func workspace(_ name: String, projects: [String]) throws -> Workspace {
        let items = projects.map { #"{"id":"\#($0)","path":"/code/\#($0)"}"# }.joined(separator: ",")
        let json = #"{"id":"\#(name)","name":"\#(name)","projects":[\#(items)]}"#
        return try JSONDecoder().decode(Workspace.self, from: Data(json.utf8))
    }

    private func card(_ id: String, _ title: String, status: String = "idle") -> MirrorCard {
        MirrorCard(sessionId: id, title: title,
                   info: SessionInfo(sessionId: id, status: status, lastOutputAt: 0, updatedAt: 0, pid: nil, exitCode: nil,
                                     currentToolName: nil, currentToolSummary: nil, runtimeKind: nil),
                   projectName: title)
    }

    func testSearchGroupsByKindAndTagsComputer() throws {
        let corpus = UnifiedSearch.Corpus(computers: [
            .init(tag: mac, chats: [chat("c1", "cc-pane 重构")], workspaces: [try workspace("main", projects: ["cc-pane"])],
                  mirror: [MirrorGroup(kind: .layout, title: "布局1", cards: [card("s1", "cc-pane")])]),
            .init(tag: pc, chats: [chat("c2", "周报")]),
        ])
        let sections = UnifiedSearch.results("cc", in: corpus)
        XCTAssertEqual(sections.map(\.kind), [.chats, .projects, .terminals])
        XCTAssertEqual(sections[0].hits.first?.tag, mac)
        guard case .project(computerId: "m", workspaceId: "main", projectId: "cc-pane") = sections[1].hits[0].destination else {
            return XCTFail("项目结果应跳到工作区启动 sheet")
        }
        guard case .terminal(let route) = sections[2].hits[0].destination else { return XCTFail() }
        XCTAssertEqual(route.computerId, "m")
    }

    func testSearchByComputerNameAndRanking() {
        let corpus = UnifiedSearch.Corpus(computers: [
            .init(tag: mac, chats: [chat("a", "xx 周报"), chat("b", "周报")]),
            .init(tag: pc, chats: [chat("c", "整理")]),
        ])
        // 前缀命中排在包含之前
        XCTAssertEqual(UnifiedSearch.results("周报", in: corpus)[0].hits.map(\.id), ["m|chat:b", "m|chat:a"])
        // 电脑名作为次要字段：只看那台电脑
        XCTAssertEqual(UnifiedSearch.results("台式机", in: corpus)[0].hits.map(\.id), ["p|chat:c"])
        // 多词：每个词都要命中
        XCTAssertTrue(UnifiedSearch.results("周报 台式机", in: corpus).isEmpty)
    }

    func testHistoryHidesLiveAndRanksAfterChats() {
        let live = chat("c", "deploy", session: "s1")
        let corpus = UnifiedSearch.Corpus(computers: [
            .init(tag: mac, chats: [live],
                  history: [AcpHistoryEntry(acpSessionId: "s1", engineId: "claude", cwd: "/w", title: "deploy"),
                            AcpHistoryEntry(acpSessionId: "s2", engineId: "claude", cwd: "/w", title: "deploy old")]),
        ])
        XCTAssertEqual(UnifiedSearch.results("deploy", in: corpus)[0].hits.map(\.id), ["m|chat:c", "m|history:s2"])
    }

    func testEmptyQuerySuggestsPendingAndWaiting() {
        let corpus = UnifiedSearch.Corpus(computers: [
            .init(tag: mac, chats: [chat("a", "x", pending: 2), chat("b", "y")],
                  mirror: [MirrorGroup(kind: .layout, title: "L", cards: [card("w", "t", status: "waitingInput"), card("i", "u")])]),
        ])
        let sections = UnifiedSearch.results("  ", in: corpus)
        XCTAssertEqual(sections.map(\.kind), [.attention])
        XCTAssertEqual(sections[0].hits.map(\.id), ["m|chat:a", "m|terminal:w"])
    }

    func testSearchTruncatesButKeepsTotal() {
        let chats = (0..<30).map { chat("c\($0)", "task \($0)") }
        let section = UnifiedSearch.results("task", in: .init(computers: [.init(tag: mac, chats: chats)]), limit: 5)[0]
        XCTAssertEqual(section.hits.count, 5)
        XCTAssertEqual(section.total, 30)
    }

    // MARK: - 状态条

    func testStatusSingleComputerShowsRoute() {
        let status = HomeStatus.make([.init(name: "Mac", status: .online, via: .tailscale)], pending: 0)
        XCTAssertEqual(status, HomeStatus(level: .online, title: "Mac", detail: "Tailscale", pending: 0))
    }

    func testStatusAggregatesAndFlagsOffline() {
        let entries: [HomeStatus.Entry] = [.init(name: "A", status: .online, via: .lan),
                                           .init(name: "B", status: .online, via: .lan),
                                           .init(name: "C", status: .offline)]
        let status = HomeStatus.make(entries, pending: 3)
        XCTAssertEqual(status.level, .warning)
        XCTAssertEqual(status.title, "2 台在线")
        XCTAssertEqual(status.detail, "C 离线")
        XCTAssertEqual(status.pending, 3)
        XCTAssertEqual(HomeStatus.make(Array(entries.prefix(2)), pending: 0).detail, "局域网")
    }

    func testStatusUnauthorizedAndHostDown() {
        XCTAssertEqual(HomeStatus.make([.init(name: "A", status: .unauthorized)], pending: 0).detail, "令牌失效")
        let down = HomeStatus.make([.init(name: "A", status: .online, via: .lan, hostDown: true)], pending: 0)
        XCTAssertEqual(down.level, .warning)
        XCTAssertEqual(down.detail, "CC-Panes 未运行")
        XCTAssertEqual(HomeStatus.make([.init(name: "A", status: .online, via: .lan, linkFailing: true)], pending: 0).detail,
                       "连接中断")
    }

    // MARK: - tab / 退避

    func testInitialTabSettingsOpensSheet() {
        let defaults = UserDefaults(suiteName: "home-shell-\(UUID().uuidString)")!
        defaults.set("settings", forKey: "initialTab")
        XCTAssertEqual(HomeTab.initial(defaults), .chat)
        XCTAssertEqual(HomeTab.initialSheet(defaults), .settings)
        defaults.set("search", forKey: "initialTab")
        XCTAssertEqual(HomeTab.initial(defaults), .search)
        XCTAssertNil(HomeTab.initialSheet(defaults))
    }

    func testBackoffCapsAtSixtySeconds() {
        XCTAssertEqual(ComputerLink.backoff(failures: 1), 2)
        XCTAssertEqual(ComputerLink.backoff(failures: 3), 8)
        XCTAssertEqual(ComputerLink.backoff(failures: 20), 60)
    }

    @MainActor
    func testRouterHandsDestinationToItsTabOnly() {
        let router = HomeRouter()
        router.open(.terminal(TerminalRoute(sessionId: "s", title: "t", computerId: "m")))
        XCTAssertEqual(router.tab, .terminal)
        XCTAssertNil(router.take(for: .chat))
        XCTAssertNotNil(router.take(for: .terminal))
        XCTAssertNil(router.take(for: .terminal), "只消费一次")
    }

    @MainActor
    func testHubLinksFollowKeepConnected() {
        let hub = ConnectionHub(vault: TokenVault(store: MemorySecretStore()), probe: { _ in false },
                                defaults: UserDefaults(suiteName: "hub-\(UUID().uuidString)")!,
                                contactsService: MockContactsService.shared)
        var paused = Computer(id: "b", name: "b", addresses: ["http://10.0.0.2:1"])
        paused.keepConnected = false
        hub.sync([Computer(id: "a", name: "a", addresses: ["http://10.0.0.1:1"]), paused])
        XCTAssertEqual(hub.links.map(\.id), ["a"])
        let first = hub.links[0]
        paused.keepConnected = true
        hub.sync([Computer(id: "a", name: "a", addresses: ["http://10.0.0.1:1"]), paused])
        XCTAssertEqual(hub.links.map(\.id), ["a", "b"])
        XCTAssertTrue(hub.links[0] === first, "已有连接复用，不重建")
    }

    @MainActor
    func testHubMarksUnreachableComputerOffline() async {
        let hub = ConnectionHub(vault: TokenVault(store: MemorySecretStore()), probe: { _ in false },
                                defaults: UserDefaults(suiteName: "hub-\(UUID().uuidString)")!,
                                contactsService: MockContactsService.shared)
        hub.sync([Computer(id: "a", name: "a", addresses: ["http://10.0.0.1:1"])])
        await hub.cycle()
        XCTAssertEqual(hub.links[0].status, .offline)
        XCTAssertEqual(hub.troubled.map(\.id), ["a"])
        XCTAssertGreaterThan(hub.links[0].nextAttempt, Date())
    }
}
