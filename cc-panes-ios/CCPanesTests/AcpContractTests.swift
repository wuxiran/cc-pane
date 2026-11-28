import XCTest
@testable import CCPanes

/// docs/112 §3 定稿契约：user_prompt 去重、*_resolved 收卡、floorSeq、嵌套详情、configOptions、列表字段。
final class AcpContractTests: XCTestCase {
    private func userPrompt(_ f: inout EventFactory, _ text: String, id: String?, origin: String) -> AcpEvent {
        var payload: [String: Any] = ["origin": origin, "blocks": [["type": "text", "text": text]]]
        if let id { payload["promptId"] = id }
        return f.event("user_prompt", payload)
    }

    func testOwnPromptEchoIsDedupedByPromptId() {
        var f = EventFactory(), s = AcpChatState()
        s.addLocalUser("你好", promptId: "p1")
        XCTAssertTrue(s.items[0].promptPending)
        s.apply(userPrompt(&f, "你好", id: "p1", origin: "mobile"))
        XCTAssertEqual(s.items.map(\.kind), [.user("你好")])
        XCTAssertFalse(s.items[0].promptPending)
        // 适配器若再回显 user_message_chunk，仍被吞掉
        s.apply(f.update(["sessionUpdate": "user_message_chunk", "content": ["type": "text", "text": "你好"]]))
        XCTAssertEqual(s.items.count, 1)
    }

    func testRemotePromptInsertsBubbleWithOrigin() {
        var f = EventFactory(), s = AcpChatState()
        s.apply(userPrompt(&f, "跑下测试", id: "desk-1", origin: "desktop"))
        s.apply(f.update(["sessionUpdate": "user_message_chunk", "content": ["type": "text", "text": "跑下测试"]]))
        s.apply(f.chunk("好的"))
        XCTAssertEqual(s.items.map(\.kind), [.user("跑下测试"), .assistant("好的")])
        XCTAssertEqual(s.items[0].origin, "desktop")
        XCTAssertEqual(AcpOrigin.label("device:mac-mini"), "mac-mini")
        XCTAssertEqual(AcpOrigin.label("bot:reviewer"), "Bot reviewer")
    }

    func testPermissionResolvedElsewhereRemovesCardWithNotice() {
        var f = EventFactory(), s = AcpChatState()
        s.apply(f.event("permission_request", ["requestKey": "k1", "params": ["toolCall": ["title": "rm -rf build"], "options": []]]))
        XCTAssertNotNil(s.dockedCard)
        s.apply(f.event("permission_resolved", ["requestKey": "k1", "optionId": "allow", "by": "desktop"]))
        XCTAssertNil(s.dockedCard)
        XCTAssertEqual(s.items.last?.kind, .notice("「rm -rf build」已在电脑端处理"))
        // 未知 key 幂等
        s.apply(f.event("permission_resolved", ["requestKey": "zzz", "by": "desktop"]))
        XCTAssertEqual(s.items.count, 1)
    }

    func testElicitationResolvedRemovesQuestion() {
        var f = EventFactory(), s = AcpChatState()
        s.apply(f.event("elicitation_request", ["requestKey": "q1", "params": ["message": "选哪个？"]]))
        XCTAssertNotNil(s.dockedCard)
        s.apply(f.event("elicitation_resolved", ["requestKey": "q1", "by": "desktop"]))
        XCTAssertNil(s.dockedCard)
    }

    func testResetFloorSeqIsFirstRetainedSeq() {
        var s = AcpChatState()
        s.apply(.reset(snapshot: .from(["chatId": "c", "phase": "ready"]), floorSeq: 100))
        XCTAssertEqual(s.lastSeq, 99)
        XCTAssertTrue(s.apply(AcpEvent(seq: 100, kind: "update", payload: .from(["update": [
            "sessionUpdate": "agent_message_chunk", "content": ["type": "text", "text": "保留的首条"]]]))))
        XCTAssertEqual(s.items.map(\.kind), [.assistant("保留的首条")])
    }

    func testDetailIsNestedSnapshot() {
        let value = JSONValue.from(["snapshot": ["chatId": "c1", "phase": "generating"], "lastSeq": 57])
        let (snapshot, lastSeq) = AcpChatSnapshot.parseDetail(value)
        XCTAssertEqual(snapshot.chatId, "c1")
        XCTAssertEqual(snapshot.phase, .generating)
        XCTAssertEqual(lastSeq, 57)
    }

    func testConfigOptionsHideLegacyCategories() {
        let snapshot = AcpChatSnapshot(.from([
            "models": ["currentModelId": "opus", "availableModels": [["modelId": "opus"]]],
            "configOptions": [
                ["configId": "model", "category": "model", "type": "select", "currentValue": "opus", "options": [["value": "opus"]]],
                ["configId": "thinking", "name": "思考", "category": "thought_level", "currentValue": "high",
                 "options": [["value": "low"], ["value": "high", "name": "高"]]],
                ["configId": "toggle", "type": "boolean", "currentValue": "x", "options": [["value": "x"]]],
                ["configId": "empty", "type": "select", "options": []],
            ],
        ]))
        let options = snapshot.configOptions
        XCTAssertEqual(options.map(\.configId), ["thinking"])
        XCTAssertEqual(options[0].currentValue, "high")
        XCTAssertEqual(options[0].choices, [AcpChoice(id: "low", name: "low"), AcpChoice(id: "high", name: "高")])
    }

    /// claude-agent-acp 线上形状：`id`（不是 configId），legacy `modes` 在时隐藏 mode 类别。
    func testConfigOptionsAcceptAcpWireId() {
        let snapshot = AcpChatSnapshot(.from([
            "modes": ["currentModeId": "default", "availableModes": [["id": "default", "name": "Manual"]]],
            "configOptions": [
                ["id": "mode", "category": "mode", "type": "select", "currentValue": "default", "options": [["value": "default"]]],
                ["id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": "haiku",
                 "options": [["value": "sonnet"], ["value": "haiku", "name": "Haiku"]]],
                ["id": "agent", "name": "Agent", "type": "select", "currentValue": "default", "options": [["value": "default"]]],
            ],
        ]))
        let options = snapshot.configOptions
        XCTAssertEqual(options.map(\.configId), ["model", "agent"])
        XCTAssertEqual(options[0].currentValue, "haiku")
    }

    func testPromptBodyCarriesPromptId() {
        let body = AcpClient.promptBody(text: "hi", promptId: "ios-1")
        XCTAssertEqual(body["promptId"]?.string, "ios-1")
        XCTAssertEqual(body["blocks"]?.array?.first?["text"]?.string, "hi")
    }

    func testSummaryListFields() throws {
        let json = #"[{"chatId":"bot-reviewer","engineId":"claude","status":"ready","lastSeq":3,"origin":"bot","pendingPermissions":2,"botId":"reviewer","updatedAt":1},{"chatId":"mobile-1","engineId":"codex","origin":"mobile"}]"#
        let list = try JSONDecoder().decode([AcpChatSummary].self, from: Data(json.utf8))
        XCTAssertTrue(list[0].isBot)
        XCTAssertEqual(list[0].botId, "reviewer")
        XCTAssertEqual(list[0].pendingPermissions, 2)
        XCTAssertFalse(list[1].isBot)
        XCTAssertTrue(list[1].isMobile)
    }
}

/// mock 端到端：user_prompt 回显 / permission_resolved / config 路由都走一遍。
@MainActor
final class AcpMockContractTests: XCTestCase {
    private func waitUntil(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(8)
        while !condition() {
            if ContinuousClock.now > deadline { return XCTFail("timeout") }
            try await Task.sleep(for: .milliseconds(20))
        }
    }

    func testMockEmitsUserPromptAndPermissionResolved() async throws {
        let service = MockAcpService(defaults: UserDefaults(suiteName: "acp-test-\(UUID())")!)
        let session = AcpChatSession(chatId: "mock-done", service: service, canWrite: true)
        session.attach()
        try await waitUntil { session.link == .live && session.state.phase == .ready && session.state.items.count >= 5 }
        let first = try XCTUnwrap(session.state.items.first)
        XCTAssertEqual(first.origin, "desktop", "剧本以电脑端 user_prompt 开场")
        XCTAssertTrue(session.state.items.contains { $0.kind == .notice("「编辑 OutputSequencerTests.swift」已在电脑端处理") })
        session.detach()
    }

    func testMockConfigOptionRoundTrip() async throws {
        let service = MockAcpService(defaults: UserDefaults(suiteName: "acp-test-\(UUID())")!)
        let created = try await service.create(engineId: "claude", cwd: "/tmp/x", resumeAcpSessionId: nil)
        let session = AcpChatSession(chatId: created.chatId!, service: service, canWrite: true)
        session.attach()
        try await waitUntil { session.link == .live && session.state.phase == .ready }
        XCTAssertEqual(session.state.snapshot?.configOptions.first?.currentValue, "medium")
        await session.setConfigOption("thinking", value: "high")
        try await waitUntil { session.state.snapshot?.configOptions.first?.currentValue == "high" }
        session.detach()
    }
}
