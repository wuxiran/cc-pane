import XCTest
@testable import CCPanes

final class ContactsTests: XCTestCase {
    private func json(_ text: String) -> JSONValue {
        try! JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }

    // MARK: - 解码

    func testDecodesContractShape() {
        let list = BotContact.parseList(json("""
        [{"id":"reviewer","name":"代码评审","avatar":"🧐","color":"#6366f1","engineId":"claude",
          "personaSummary":"严格评审","status":"ready","remotePolicy":"allowlist",
          "remoteAllowKinds":["read","search"],"remoteShared":true,"chatId":"bot-reviewer"}]
        """), nodeId: "mac")
        XCTAssertEqual(list.count, 1)
        let bot = list[0]
        XCTAssertEqual(bot.id, "mac/reviewer")
        XCTAssertEqual(bot.chatId, "bot-reviewer")
        XCTAssertEqual(bot.avatarText, "🧐")
        XCTAssertEqual(bot.engineId, "claude")
        XCTAssertEqual(bot.remotePolicy, .allowlist)
        XCTAssertEqual(bot.personaSummary, "严格评审")
        XCTAssertEqual(bot.remoteAllowKinds, ["read", "search"])
        XCTAssertTrue(bot.remoteShared)
        XCTAssertEqual(bot.color, "#6366f1")
    }

    func testToleratesMissingAndRenamedFields() {
        let list = BotContact.parseList(json("""
        {"bots":[
          {"id":"a"},
          {"botId":"b","displayName":"Bee","engine":"codex","persona":"第一行\\n第二行","phase":"generating",
           "policy":"ask-origin","effectiveCwd":"/w","chatId":"bot-b2","unknownField":1},
          {"name":"没有 id 的条目被跳过"},
          {"id":"   "}
        ]}
        """), nodeId: "n")
        XCTAssertEqual(list.map(\.botId), ["a", "b"])
        let a = list[0]
        XCTAssertEqual(a.name, "a")
        XCTAssertEqual(a.engineId, "claude")
        XCTAssertEqual(a.remotePolicy, .askOrigin, "缺省按契约默认 ask_origin")
        XCTAssertNil(a.status)
        XCTAssertEqual(a.avatarText, "A")
        let b = list[1]
        XCTAssertEqual(b.name, "Bee")
        XCTAssertEqual(b.engineId, "codex")
        XCTAssertEqual(b.personaSummary, "第一行", "完整人设只取首行")
        XCTAssertEqual(b.status, "generating")
        XCTAssertEqual(b.remotePolicy, .askOrigin)
        XCTAssertEqual(b.cwd, "/w")
        XCTAssertEqual(b.chatId, "bot-b2")
    }

    func testNonArrayGarbageYieldsEmpty() {
        XCTAssertTrue(BotContact.parseList(json("{\"code\":\"X\"}"), nodeId: "n").isEmpty)
        XCTAssertTrue(BotContact.parseList(.null, nodeId: "n").isEmpty)
    }

    func testMergesChatSummary() {
        var bot = BotContact.parse(json("{\"id\":\"r\"}"), nodeId: "n")!
        bot.merge(chat: AcpChatSummary(chatId: "bot-r", engineId: "claude", status: "generating", lastSeq: 9,
                                       updatedAt: 1000, pendingPermissions: 2))
        XCTAssertEqual(bot.pendingPermissions, 2)
        XCTAssertEqual(bot.lastSeq, 9)
        XCTAssertEqual(bot.status, "generating")
        XCTAssertEqual(BotPresence(contact: bot, nodeOnline: true), .waiting, "待审批压过工作中")
    }

    // MARK: - 策略

    func testPolicyParsingAndDisplay() {
        XCTAssertEqual(RemotePolicy(raw: "deny"), .deny)
        XCTAssertEqual(RemotePolicy(raw: "ask_origin"), .askOrigin)
        XCTAssertEqual(RemotePolicy(raw: "askOrigin"), .askOrigin)
        XCTAssertEqual(RemotePolicy(raw: "allowlist"), .allowlist)
        XCTAssertEqual(RemotePolicy(raw: "FULL"), .full)
        XCTAssertEqual(RemotePolicy(raw: nil), .askOrigin)
        XCTAssertEqual(RemotePolicy(raw: "yolo"), .unknown("yolo"))
        XCTAssertEqual(RemotePolicy.levels.map(\.raw), ["deny", "ask_origin", "allowlist", "full"])
        XCTAssertEqual(RemotePolicy.levels.filter(\.isDangerous), [.full], "只有 full 需要红色警示")
        XCTAssertEqual(RemotePolicy.deny.label, "工具全拒", "deny = 能聊天、工具全拒（§5.8）")
        XCTAssertEqual(RemotePolicy.full.label, "完全信任")
        XCTAssertEqual(RemotePolicy.kindLabel("execute"), "执行命令")
        XCTAssertFalse(RemotePolicy.allowKinds.map(\.id).contains("*"), "allowlist 不接受通配")
        XCTAssertEqual(RemotePolicy(raw: "yolo").raw, "yolo", "未知值原样保留")
    }

    func testPatchBody() {
        XCTAssertEqual(BotRemoteChange(policy: .askOrigin).body,
                       .object(["remotePolicy": .string("ask_origin")]))
        XCTAssertEqual(BotRemoteChange(policy: .full, confirmFull: true).body,
                       .object(["remotePolicy": .string("full"), "confirmFull": .bool(true)]))
        XCTAssertEqual(BotRemoteChange(allowKinds: ["read"]).body,
                       .object(["remoteAllowKinds": .array([.string("read")])]))
    }

    func testMessageBody() {
        let body = ContactsAPI.messageBody(text: "hi", promptId: "p1", device: "iPhone")
        XCTAssertEqual(body["text"]?.string, "hi")
        XCTAssertEqual(body["promptId"]?.string, "p1")
        XCTAssertEqual(body["from"]?["device"]?.string, "iPhone")
        XCTAssertEqual(ContactsAPI.messages("a b"), "/api/bots/a%20b/messages")
    }

    // MARK: - 在线态

    func testPresence() {
        func bot(_ status: String?) -> BotContact {
            BotContact.parse(json(status.map { "{\"id\":\"x\",\"status\":\"\($0)\"}" } ?? "{\"id\":\"x\"}"), nodeId: "n")!
        }
        XCTAssertEqual(BotPresence(contact: bot("ready"), nodeOnline: true), .online)
        XCTAssertEqual(BotPresence(contact: bot("generating"), nodeOnline: true), .busy)
        XCTAssertEqual(BotPresence(contact: bot("starting"), nodeOnline: true), .busy)
        XCTAssertEqual(BotPresence(contact: bot("idle"), nodeOnline: true), .dormant, "idle = 未启动")
        XCTAssertEqual(BotPresence(contact: bot(nil), nodeOnline: true), .dormant)
        XCTAssertEqual(BotPresence(contact: bot("exited"), nodeOnline: true), .ended(failed: false))
        XCTAssertEqual(BotPresence(contact: bot("failed"), nodeOnline: true).label, "失败")
        XCTAssertEqual(BotPresence(contact: bot("ready"), nodeOnline: false), .unreachable)
        XCTAssertEqual(BotPresence.unreachable.phase, .exited)
    }

    // MARK: - 分组排序

    private func contact(_ node: String, _ id: String, _ name: String, status: String? = "ready",
                         pending: Int = 0, persona: String? = nil) -> BotContact {
        BotContact(nodeId: node, botId: id, name: name, engineId: "claude", personaSummary: persona, status: status,
                   remotePolicy: .askOrigin, chatId: "bot-\(id)", pendingPermissions: pending)
    }

    func testSectionsOrderCurrentFirstThenOnlineThenUnavailable() {
        let nodes = [ContactNode(id: "off", name: "A 离线", isCurrent: false),
                     ContactNode(id: "b", name: "B 在线", isCurrent: false),
                     ContactNode(id: "cur", name: "Z 当前", isCurrent: true),
                     ContactNode(id: "load", name: "C 加载中", isCurrent: false)]
        let dirs: [String: NodeDirectory] = [
            "off": NodeDirectory(status: .offline),
            "b": NodeDirectory(status: .online, bots: [contact("b", "1", "x")]),
            "cur": NodeDirectory(status: .online, bots: []),
        ]
        let sections = ContactsDirectory.sections(nodes: nodes, directories: dirs)
        XCTAssertEqual(sections.map(\.id), ["cur", "b", "load", "off"])
        XCTAssertEqual(sections[2].directory.status, .loading, "未返回的电脑显示加载中")
    }

    func testContactsSortedByPresenceThenName() {
        let bots = [contact("n", "1", "b-idle"), contact("n", "2", "a-dormant", status: nil),
                    contact("n", "3", "c-busy", status: "generating"), contact("n", "4", "d-pending", pending: 1),
                    contact("n", "5", "a-idle")]
        let sections = ContactsDirectory.sections(nodes: [ContactNode(id: "n", name: "n", isCurrent: true)],
                                                  directories: ["n": NodeDirectory(status: .online, bots: bots)])
        XCTAssertEqual(sections[0].contacts.map(\.name), ["d-pending", "c-busy", "a-idle", "b-idle", "a-dormant"])
    }

    func testSearchFiltersContactsAndHidesEmptyNodes() {
        let nodes = [ContactNode(id: "a", name: "公司台式机", isCurrent: true),
                     ContactNode(id: "b", name: "家里", isCurrent: false)]
        let dirs: [String: NodeDirectory] = [
            "a": NodeDirectory(status: .online, bots: [contact("a", "1", "评审", persona: "Rust review")]),
            "b": NodeDirectory(status: .online, bots: [contact("b", "2", "日报")]),
        ]
        XCTAssertEqual(ContactsDirectory.sections(nodes: nodes, directories: dirs, query: "rust").map(\.id), ["a"])
        XCTAssertEqual(ContactsDirectory.sections(nodes: nodes, directories: dirs, query: "家里")
            .flatMap(\.contacts).map(\.name), ["日报"], "按电脑名也能搜到")
        XCTAssertEqual(ContactsDirectory.sections(nodes: nodes, directories: dirs, query: "  ").count, 2)
    }

    func testRemotePendingExcludesCurrentAndOffline() {
        let nodes = [ContactNode(id: "cur", name: "cur", isCurrent: true),
                     ContactNode(id: "r", name: "r", isCurrent: false),
                     ContactNode(id: "off", name: "off", isCurrent: false)]
        let dirs: [String: NodeDirectory] = [
            "cur": NodeDirectory(status: .online, bots: [contact("cur", "1", "x", pending: 5)]),
            "r": NodeDirectory(status: .online, bots: [contact("r", "2", "y", pending: 2), contact("r", "3", "z", pending: 1)]),
            "off": NodeDirectory(status: .offline, bots: [contact("off", "4", "w", pending: 9)]),
        ]
        XCTAssertEqual(ContactsDirectory.remotePending(nodes: nodes, directories: dirs), 3)
    }

    // MARK: - 已读

    func testReadMarks() {
        let defaults = UserDefaults(suiteName: "contacts-tests-\(UUID().uuidString)")!
        let marks = ContactReadMarks(defaults: defaults)
        var bot = contact("n", "1", "x")
        bot.lastSeq = 10
        XCTAssertFalse(marks.isUnread(bot), "首次见到不标")
        marks.reconcile([bot])
        bot.lastSeq = 12
        XCTAssertTrue(marks.isUnread(bot))
        marks.markSeen(bot)
        XCTAssertFalse(marks.isUnread(bot))
        bot.lastSeq = 3 // 电脑端重启，seq 重新计数
        marks.reconcile([bot])
        bot.lastSeq = 4
        XCTAssertTrue(marks.isUnread(bot), "回落后新动静照样亮")
    }

    // MARK: - HTTP 错误映射

    func testHTTPErrorMapping() {
        XCTAssertEqual(ContactsHTTPError.network("x").nodeStatus, .offline)
        XCTAssertEqual(ContactsHTTPError.unauthorized.nodeStatus, .tokenRejected)
        XCTAssertEqual(ContactsHTTPError.status(404, code: nil, message: "").nodeStatus, .unsupported)
        XCTAssertEqual(ContactsHTTPError.status(503, code: "ACP_HOST_UNAVAILABLE", message: "").nodeStatus, .hostUnavailable)
        XCTAssertEqual(ContactsHTTPError.status(403, code: "BOT_REMOTE_DENIED", message: "x").errorDescription,
                       "这个 Bot 没有对其他设备共享，无法远程发消息")
        for code in ["BOT_NOT_FOUND", "BOT_FULL_CONFIRM_REQUIRED", "MESH_HOPS_EXCEEDED", "MESH_LOOP_DETECTED", "MESH_BUSY"] {
            XCTAssertNotNil(ContactsHTTPError.message(code: code), code)
        }
        XCTAssertEqual(ContactsHTTPError.status(500, code: "WHATEVER", message: "boom").errorDescription, "boom")
    }

    func testExternalPromptAnnouncementIsNotANotice() {
        var state = AcpChatState()
        state.apply(.event(AcpEvent(seq: 1, kind: "external_prompt",
                                    payload: .from(["text": "hi", "origin": "device:iPhone", "promptId": "p"]))))
        XCTAssertTrue(state.items.isEmpty, "external_prompt 只是公告，气泡由 user_prompt 负责")
    }

    // MARK: - Bot 对话：未启动时先同步空闲，发出首条后重连

    func testBotChatDormantThenWakesAfterSend() async throws {
        let base = MockAcpService()
        let service = BotChatService(base: base, botChatId: "bot-z", dormantPoll: .seconds(30)) { text, promptId in
            await base.ensureBotChat(chatId: "bot-z", botId: "z", engineId: "claude", cwd: "/tmp", title: "Z")
            try await base.prompt(chatId: "bot-z", text: text, promptId: promptId)
        }
        var iterator = await service.openStream(chatId: "bot-z", afterSeq: 0).makeAsyncIterator()
        let first = await iterator.next()
        XCTAssertEqual(first, .synchronized(lastSeq: 0), "Bot 未启动：视作已同步的空对话")
        try await service.prompt(chatId: "bot-z", text: "你好", promptId: "p-1")
        var sawState = false, sawSync = false
        while let frame = await iterator.next() {
            if case .event(let e) = frame, e.kind == "state" { sawState = true }
            if case .synchronized = frame { sawSync = true; break }
        }
        XCTAssertTrue(sawState, "唤醒后重连拿到 Bot 对话的事件环")
        XCTAssertTrue(sawSync)
    }
}
