import XCTest
@testable import CCPanes

/// 事件构造辅助：按递增 seq 生成帧。
struct EventFactory {
    var seq = 0

    mutating func event(_ kind: String, _ payload: [String: Any]) -> AcpEvent {
        seq += 1
        return AcpEvent(seq: seq, kind: kind, payload: .from(payload))
    }

    mutating func update(_ fields: [String: Any]) -> AcpEvent {
        event("update", ["sessionId": "s", "update": fields])
    }

    mutating func chunk(_ text: String, thought: Bool = false, parent: String? = nil) -> AcpEvent {
        var fields: [String: Any] = ["sessionUpdate": thought ? "agent_thought_chunk" : "agent_message_chunk",
                                     "content": ["type": "text", "text": text]]
        if let parent { fields["_meta"] = ["claudeCode": ["parentToolUseId": parent]] }
        return update(fields)
    }

    mutating func state(_ phase: String, error: String? = nil) -> AcpEvent {
        var payload: [String: Any] = ["chatId": "c", "engineId": "claude", "phase": phase]
        if let error { payload["error"] = error }
        return event("state", payload)
    }
}

final class AcpChatStateTests: XCTestCase {
    private func kinds(_ state: AcpChatState) -> [ChatItem.Kind] { state.items.map(\.kind) }

    // MARK: - chunk 合并

    func testAdjacentChunksMergeIntoOneBubble() {
        var f = EventFactory(), s = AcpChatState()
        s.apply(f.chunk("Hel"))
        s.apply(f.chunk("lo"))
        XCTAssertEqual(kinds(s), [.assistant("Hello")])
    }

    func testThoughtThenAnswerClosesThought() {
        var f = EventFactory(), s = AcpChatState()
        s.apply(f.chunk("想", thought: true))
        s.apply(f.chunk("一想", thought: true))
        s.apply(f.chunk("答"))
        XCTAssertEqual(kinds(s), [.thought("想一想", done: true), .assistant("答")])
    }

    func testChunksFromDifferentParentsDoNotMerge() {
        var f = EventFactory(), s = AcpChatState()
        s.apply(f.chunk("主"))
        s.apply(f.chunk("子", parent: "task-1"))
        XCTAssertEqual(s.items.count, 2)
        XCTAssertEqual(s.items[1].parentToolCallId, "task-1")
    }

    func testChunkAfterToolCallStartsNewBubble() {
        var f = EventFactory(), s = AcpChatState()
        s.apply(f.chunk("a"))
        s.apply(f.update(["sessionUpdate": "tool_call", "toolCallId": "t1", "title": "读文件"]))
        s.apply(f.chunk("b"))
        XCTAssertEqual(s.items.count, 3)
        XCTAssertEqual(s.items[2].kind, .assistant("b"))
    }

    func testItemIdIsStableWhileStreaming() {
        var f = EventFactory(), s = AcpChatState()
        s.apply(f.chunk("a"))
        let id = s.items[0].id
        s.apply(f.chunk("b"))
        XCTAssertEqual(s.items[0].id, id)
    }

    func testNonTextChunkDegradesToPlaceholder() {
        var f = EventFactory(), s = AcpChatState()
        s.apply(f.update(["sessionUpdate": "agent_message_chunk", "content": ["type": "resource_link", "uri": "x"]]))
        XCTAssertEqual(kinds(s), [.assistant("[resource_link]")])
    }

    // MARK: - tool_call

    func testToolCallUpdateMergesById() {
        var f = EventFactory(), s = AcpChatState()
        s.apply(f.update(["sessionUpdate": "tool_call", "toolCallId": "t1", "title": "跑测试", "kind": "execute", "status": "pending"]))
        s.apply(f.chunk("中间"))
        s.apply(f.update(["sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed",
                          "content": [["type": "content", "content": ["type": "text", "text": "ok"]]]]))
        XCTAssertEqual(s.items.count, 2)
        guard case .toolCall(let call) = s.items[0].kind else { return XCTFail("not tool call") }
        XCTAssertEqual(call.status, "completed")
        XCTAssertEqual(call.title, "跑测试", "未给出的字段保留")
        XCTAssertEqual(call.kind, "execute")
        XCTAssertEqual(call.renderedContent, [.text("ok")])
    }

    func testToolCallContentIsReplacedNotAppended() {
        var f = EventFactory(), s = AcpChatState()
        s.apply(f.update(["sessionUpdate": "tool_call", "toolCallId": "t1",
                          "content": [["type": "content", "content": ["type": "text", "text": "a"]]]]))
        s.apply(f.update(["sessionUpdate": "tool_call_update", "toolCallId": "t1",
                          "content": [["type": "content", "content": ["type": "text", "text": "b"]]]]))
        guard case .toolCall(let call) = s.items[0].kind else { return XCTFail() }
        XCTAssertEqual(call.renderedContent, [.text("b")])
    }

    func testOrphanToolCallUpdateCreatesCard() {
        var f = EventFactory(), s = AcpChatState()
        s.apply(f.update(["sessionUpdate": "tool_call_update", "toolCallId": "t9", "status": "in_progress"]))
        guard case .toolCall(let call) = s.items.first?.kind else { return XCTFail() }
        XCTAssertEqual(call.toolCallId, "t9")
    }

    func testDiffContentParsed() {
        var f = EventFactory(), s = AcpChatState()
        s.apply(f.update(["sessionUpdate": "tool_call", "toolCallId": "t1", "locations": [["path": "a.swift", "line": 3]],
                          "content": [["type": "diff", "path": "a.swift", "oldText": "x", "newText": "y"]]]))
        guard case .toolCall(let call) = s.items[0].kind else { return XCTFail() }
        XCTAssertEqual(call.locations, ["a.swift:3"])
        XCTAssertEqual(call.renderedContent, [.diff(path: "a.swift", oldText: "x", newText: "y")])
        XCTAssertEqual(ToolContentPiece.diffLines(old: "x", new: "y").map(\.sign), ["-", "+"])
    }

    // MARK: - plan / misc updates

    func testPlanReplacesPreviousPlanCard() {
        var f = EventFactory(), s = AcpChatState()
        s.apply(f.update(["sessionUpdate": "plan", "entries": [["content": "a", "status": "pending"]]]))
        s.apply(f.chunk("x"))
        s.apply(f.update(["sessionUpdate": "plan", "entries": [["content": "a", "status": "completed"], ["content": "b"]]]))
        XCTAssertEqual(s.items.count, 2)
        XCTAssertEqual(s.items[0].kind, .plan([AcpPlanEntry(content: "a", status: "completed"), AcpPlanEntry(content: "b")]))
    }

    func testUnknownUpdateVariantBecomesNoticeOnce() {
        var f = EventFactory(), s = AcpChatState()
        s.apply(f.update(["sessionUpdate": "brand_new_thing"]))
        s.apply(f.update(["sessionUpdate": "brand_new_thing"]))
        XCTAssertEqual(kinds(s), [.notice("[ACP] 未渲染的更新类型: brand_new_thing")])
    }

    func testUnknownEventKindBecomesNotice() {
        var f = EventFactory(), s = AcpChatState()
        s.apply(f.event("mystery_kind", [:]))
        XCTAssertEqual(kinds(s), [.notice("[ACP] 未处理的事件类型: mystery_kind")])
    }

    func testProtocolNoiseAndKnownSilentUpdatesAreNotRendered() {
        var f = EventFactory(), s = AcpChatState()
        s.apply(f.event("protocol_noise", ["line": "garbage"]))
        s.apply(f.update(["sessionUpdate": "session_info_update", "title": "t"]))
        s.apply(f.update(["sessionUpdate": "available_commands_update", "availableCommands": [["name": "init"]]]))
        s.apply(f.update(["sessionUpdate": "usage_update", "used": 10, "size": 100]))
        XCTAssertTrue(s.items.isEmpty)
        XCTAssertEqual(s.availableCommands, ["init"])
        XCTAssertEqual(s.usage, AcpUsage(used: 10, size: 100))
    }

    func testCurrentModeUpdatePatchesSnapshot() {
        var f = EventFactory(), s = AcpChatState()
        s.apply(f.event("state", ["phase": "ready", "modes": ["currentModeId": "default",
                                                              "availableModes": [["id": "default"], ["id": "plan"]]]]))
        s.apply(f.update(["sessionUpdate": "current_mode_update", "currentModeId": "plan"]))
        XCTAssertEqual(s.snapshot?.currentModeId, "plan")
        XCTAssertEqual(s.snapshot?.modes.map(\.id), ["default", "plan"])
    }

    func testAutoApprovedAndLoadFailedNotifications() {
        var f = EventFactory(), s = AcpChatState()
        s.apply(f.event("notification", ["method": "ccpanes/load-failed"]))
        s.apply(f.event("notification", ["method": "ccpanes/auto-approved", "resolvedKind": "execute",
                                         "params": ["toolCall": ["title": "ls"]]]))
        s.apply(f.event("notification", ["method": "something/else"]))
        XCTAssertEqual(kinds(s), [.notice("未能续接历史对话，已开始新会话"), .notice("已自动放行：ls（执行）")])
    }

    func testTurnEndedCancelledShowsNoticeAndClosesThought() {
        var f = EventFactory(), s = AcpChatState()
        s.apply(f.chunk("想", thought: true))
        s.apply(f.event("turn_ended", ["stopReason": "end_turn"]))
        XCTAssertEqual(kinds(s), [.thought("想", done: true)])
        s.apply(f.event("turn_ended", ["stopReason": "cancelled"]))
        XCTAssertEqual(s.items.last?.kind, .notice("已取消本轮"))
    }

    func testStateErrorBecomesNoticeOncePerChange() {
        var f = EventFactory(), s = AcpChatState()
        s.apply(f.state("failed", error: "握手失败"))
        s.apply(f.state("failed", error: "握手失败"))
        XCTAssertEqual(kinds(s), [.notice("握手失败")])
        XCTAssertEqual(s.phase, .failed)
    }
}
