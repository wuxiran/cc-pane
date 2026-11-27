import XCTest
@testable import CCPanes

/// 审批 / 提问生命周期、seq 去重、reset、历史回放、用户回显。
final class AcpChatStateLifecycleTests: XCTestCase {
    private func permission(_ f: inout EventFactory, key: String) -> AcpEvent {
        f.event("permission_request", [
            "requestKey": key,
            "params": ["toolCall": ["toolCallId": "t1", "title": "rm -rf build", "kind": "execute",
                                    "rawInput": ["command": "rm -rf build"]],
                       "options": [["optionId": "a", "name": "允许", "kind": "allow_once"],
                                   ["optionId": "r", "name": "拒绝", "kind": "reject_once"]]],
        ])
    }

    // MARK: - 审批

    func testPermissionRequestParsesOptionsFromPayload() {
        var f = EventFactory(), s = AcpChatState()
        s.apply(permission(&f, key: "k1"))
        guard case .permission(let p) = s.dockedCard else { return XCTFail("no card") }
        XCTAssertEqual(p.title, "rm -rf build")
        XCTAssertEqual(p.detail, "rm -rf build")
        XCTAssertEqual(p.toolKind, "execute")
        XCTAssertEqual(p.options.map(\.optionId), ["a", "r"])
        XCTAssertEqual(p.options.map(\.isAllow), [true, false])
    }

    func testDuplicateRequestKeyReplacesInsteadOfQueueing() {
        var f = EventFactory(), s = AcpChatState()
        s.apply(permission(&f, key: "k1"))
        s.apply(permission(&f, key: "k1"))
        XCTAssertEqual(s.pendingPermissions.count, 1)
    }

    func testPermissionResolvedElsewhereRemovesCard() {
        var f = EventFactory(), s = AcpChatState()
        s.apply(permission(&f, key: "k1"))
        s.apply(permission(&f, key: "k2"))
        s.apply(f.event("permission_resolved", ["requestKey": "k1"]))
        XCTAssertEqual(s.pendingPermissions.map(\.requestKey), ["k2"])
        s.apply(f.event("permission_resolved", ["requestKey": "unknown"]))
        XCTAssertEqual(s.pendingPermissions.count, 1, "未知 key 幂等")
    }

    func testTurnEndedAndTerminalStateClearPending() {
        var f = EventFactory(), s = AcpChatState()
        s.apply(permission(&f, key: "k1"))
        s.apply(f.event("turn_ended", ["stopReason": "end_turn"]))
        XCTAssertNil(s.dockedCard)
        s.apply(permission(&f, key: "k2"))
        s.apply(f.state("exited"))
        XCTAssertNil(s.dockedCard)
    }

    func testOnlyOneDockedCardPermissionFirst() {
        var f = EventFactory(), s = AcpChatState()
        s.apply(f.event("elicitation_request", ["requestKey": "q1", "params": [
            "mode": "form", "message": "选一个",
            "requestedSchema": ["type": "object", "properties": ["pick": ["type": "string", "enum": ["a", "b"]]], "required": ["pick"]],
        ]]))
        s.apply(permission(&f, key: "k1"))
        guard case .permission = s.dockedCard else { return XCTFail("审批优先") }
        s.apply(f.event("permission_resolved", ["requestKey": "k1"]))
        guard case .question(let q) = s.dockedCard else { return XCTFail("轮到提问") }
        XCTAssertEqual(q.form.fields.first?.choices.map(\.value), ["a", "b"])
        XCTAssertFalse(q.form.unsupported)
        s.apply(f.event("elicitation_cancelled", ["requestKey": "q1"]))
        XCTAssertNil(s.dockedCard)
    }

    func testQuestionFormContent() {
        let form = QuestionForm.parse(mode: "form", schema: .from([
            "type": "object",
            "properties": ["n": ["type": "integer"], "note": ["type": "string"]],
            "required": ["n"],
        ]))
        XCTAssertNil(form.content(from: [:]), "必填缺失")
        XCTAssertNil(form.content(from: ["n": .string("1.5")]), "整数校验")
        XCTAssertEqual(form.content(from: ["n": .string("3")]), ["n": .number(3)])
        XCTAssertTrue(QuestionForm.parse(mode: "url", schema: nil).unsupported)
    }

    // MARK: - seq / reset

    func testDuplicateSeqIsDropped() {
        var f = EventFactory(), s = AcpChatState()
        let e = f.chunk("a")
        XCTAssertTrue(s.apply(e))
        XCTAssertFalse(s.apply(e))
        XCTAssertFalse(s.apply(AcpFrame.event(AcpEvent(seq: 0, kind: "update", payload: .null))))
        XCTAssertEqual(s.items, [ChatItem(id: s.items[0].id, kind: .assistant("a"))])
        XCTAssertEqual(s.lastSeq, 1)
    }

    func testSynchronizedMarksLive() {
        var s = AcpChatState()
        s.apply(.synchronized(lastSeq: 5))
        XCTAssertTrue(s.synchronized)
        XCTAssertEqual(s.lastSeq, 5)
        s.apply(.closed(status: nil))
        XCTAssertFalse(s.synchronized)
    }

    func testResetClearsTranscriptAndReplaysFromFloor() {
        var f = EventFactory(), s = AcpChatState()
        s.apply(f.chunk("old"))
        s.apply(permission(&f, key: "k1"))
        s.apply(.reset(snapshot: .from(["chatId": "c", "phase": "generating"]), floorSeq: 100))
        XCTAssertTrue(s.items.isEmpty)
        XCTAssertNil(s.dockedCard)
        XCTAssertEqual(s.phase, .generating)
        // 无论服务端从 floorSeq 还是 floorSeq+1 开始重放都能接住
        XCTAssertTrue(s.apply(AcpEvent(seq: 100, kind: "update", payload: .from(
            ["update": ["sessionUpdate": "agent_message_chunk", "content": ["type": "text", "text": "new"]]]))))
        XCTAssertEqual(s.items.map(\.kind), [.assistant("new")])
    }

    func testFrameParsing() {
        XCTAssertEqual(AcpFrame.parse(Data(#"{"type":"event","seq":42,"kind":"update","payload":{"a":1}}"#.utf8)),
                       .event(AcpEvent(seq: 42, kind: "update", payload: .from(["a": 1]))))
        XCTAssertEqual(AcpFrame.parse(Data(#"{"type":"reset","snapshot":{},"floorSeq":100}"#.utf8)),
                       .reset(snapshot: .object([:]), floorSeq: 100))
        XCTAssertEqual(AcpFrame.parse(Data(#"{"type":"synchronized","lastSeq":57}"#.utf8)), .synchronized(lastSeq: 57))
        XCTAssertNil(AcpFrame.parse(Data(#"{"type":"nope"}"#.utf8)))
    }

    func testDetailParsesFlatAndWrapped() {
        let flat = AcpChatSnapshot.parseDetail(.from(["chatId": "c", "phase": "ready", "lastSeq": 9]))
        XCTAssertEqual(flat.0.chatId, "c")
        XCTAssertEqual(flat.1, 9)
        let wrapped = AcpChatSnapshot.parseDetail(.from(["snapshot": ["chatId": "d"], "lastSeq": 3]))
        XCTAssertEqual(wrapped.0.chatId, "d")
        XCTAssertEqual(wrapped.1, 3)
    }

    // MARK: - 历史回放

    func testHistoryReplayCommitReplacesAndAbortKeeps() {
        var f = EventFactory(), s = AcpChatState()
        s.apply(f.chunk("旧画面"))
        s.apply(f.event("history_replay", ["phase": "begin", "acpSessionId": "s1"]))
        s.apply(f.chunk("回放"))
        XCTAssertEqual(s.items.map(\.kind), [.assistant("旧画面")], "回放确认前旧画面不动")
        s.apply(f.event("history_replay", ["phase": "abort", "acpSessionId": "s1"]))
        XCTAssertEqual(s.items.map(\.kind), [.assistant("旧画面")])

        s.apply(f.event("history_replay", ["phase": "begin", "acpSessionId": "s1"]))
        s.apply(f.update(["sessionUpdate": "user_message_chunk", "content": ["type": "text", "text": "问"]]))
        s.apply(f.chunk("答"))
        s.apply(f.event("history_replay", ["phase": "commit", "acpSessionId": "s1"]))
        XCTAssertEqual(s.items.map(\.kind), [.assistant("旧画面"), .user("问"), .assistant("答")])
    }

    // MARK: - 用户回显

    func testLocalUserEchoIsSwallowed() {
        var f = EventFactory(), s = AcpChatState()
        s.addLocalUser("你好世界")
        s.apply(f.update(["sessionUpdate": "user_message_chunk", "content": ["type": "text", "text": "你好"]]))
        s.apply(f.update(["sessionUpdate": "user_message_chunk", "content": ["type": "text", "text": "世界"]]))
        XCTAssertEqual(s.items.map(\.kind), [.user("你好世界")])
        XCTAssertEqual(s.items[0].echoRemaining, "")
    }

    func testRemoteUserMessageAppearsAsBubble() {
        var f = EventFactory(), s = AcpChatState()
        s.apply(f.update(["sessionUpdate": "user_message_chunk", "content": ["type": "text", "text": "电脑端"]]))
        s.apply(f.update(["sessionUpdate": "user_message_chunk", "content": ["type": "text", "text": "发的"]]))
        XCTAssertEqual(s.items.map(\.kind), [.user("电脑端发的")])
    }

    func testTerminalOutputStored() {
        var f = EventFactory(), s = AcpChatState()
        s.apply(f.event("terminal_output", ["terminalId": "term1", "output": "hi", "truncated": false,
                                            "exitStatus": ["exitCode": 0]]))
        XCTAssertEqual(s.terminals["term1"], AcpTerminalOutput(terminalId: "term1", output: "hi", truncated: false, exitCode: 0))
    }
}
