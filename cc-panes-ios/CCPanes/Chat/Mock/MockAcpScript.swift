import Foundation

/// mock 会话剧本：一轮逼真的 ACP 事件序列（与桌面实际收到的 payload 同形）。
enum MockAcpScript {
    enum Step: Sendable {
        case emit(delayMs: Int, kind: String, payload: JSONValue)
        /// 等待审批回复（或 `-acpMockResolveAfter N` 秒后模拟「电脑端已处理」）。
        case awaitPermission(requestKey: String)
    }

    static func update(_ fields: [String: Any]) -> JSONValue {
        .from(["sessionId": "mock-session", "update": fields])
    }

    static func state(_ chatId: String, engine: String, cwd: String, phase: String,
                      config: [String: String] = [:]) -> JSONValue {
        .from([
            "chatId": chatId, "engineId": engine, "cwd": cwd, "phase": phase,
            "acpSessionId": "acp-\(chatId)", "protocolVersion": 1,
            "modes": ["currentModeId": "default", "availableModes": [
                ["id": "default", "name": "默认"], ["id": "acceptEdits", "name": "自动接受编辑"],
                ["id": "plan", "name": "计划模式"],
            ]],
            "models": ["currentModelId": "opus", "availableModels": [
                ["modelId": "opus", "name": "Opus"], ["modelId": "sonnet", "name": "Sonnet"],
            ]],
            "configOptions": [
                ["configId": "model", "category": "model", "type": "select", "currentValue": "opus",
                 "options": [["value": "opus"], ["value": "sonnet"]]],
                ["configId": "thinking", "name": "思考强度", "category": "thought_level", "type": "select",
                 "currentValue": config["thinking"] ?? "medium",
                 "options": [["value": "low", "name": "低"], ["value": "medium", "name": "中"], ["value": "high", "name": "高"]]],
            ],
        ])
    }

    /// `user_prompt` 事件 payload（§3.2）。
    static func userPrompt(_ text: String, promptId: String, origin: String) -> JSONValue {
        .from(["promptId": promptId, "origin": origin, "blocks": [["type": "text", "text": text]]])
    }

    /// 按字符数切片模拟 token 流。
    static func chunks(_ text: String, size: Int = 6) -> [String] {
        var out: [String] = []
        var current = ""
        for ch in text {
            current.append(ch)
            if current.count >= size { out.append(current); current = "" }
        }
        if !current.isEmpty { out.append(current) }
        return out
    }

    static func stream(_ text: String, variant: String, delayMs: Int) -> [Step] {
        chunks(text).map { piece in
            .emit(delayMs: delayMs, kind: "update",
                  payload: update(["sessionUpdate": variant, "content": ["type": "text", "text": piece]]))
        }
    }

    static let answer = """
    好的，我先看了 `OutputSequencer` 的实现。`reset()` 会清空 `snapshotEnd` 与缓冲帧，\
    但目前没有测试覆盖这条路径。

    ## 计划
    - 新增 `testResetClearsPending`：快照前缓冲两帧，reset 后再套快照，确认旧帧不会被冲刷
    - 顺手把断言改成 **逐帧** 比对

    ```swift
    func testResetClearsPending() {
        var s = OutputSequencer()
        _ = s.accept(.init(data: "old", endSeq: 3))
        s.reset()
        XCTAssertEqual(s.snapshotApplied(endSeq: 0), "")
    }
    ```

    下面写入测试文件。
    """

    static let summary = "测试已通过 ✅ 新增 1 个用例，`OutputSequencerTests` 共 6 个全部绿。需要的话我可以再补一个 UTF-8 边界的用例。"

    /// 完整一轮：prompt → 思考 → 流式 Markdown → 工具调用待审批 → 审批 → 完成 → plan → 收尾。
    static func turn(chatId: String, engine: String, cwd: String, prompt: String, delay: Int) -> [Step] {
        let key = "perm-\(chatId)-1"
        let edit = "tool-edit-1"
        let run = "tool-run-1"
        var steps: [Step] = [
            .emit(delayMs: 0, kind: "state", payload: state(chatId, engine: engine, cwd: cwd, phase: "ready")),
            .emit(delayMs: delay * 3, kind: "user_prompt",
                  payload: userPrompt(prompt, promptId: "desk-\(chatId)-1", origin: "desktop")),
            .emit(delayMs: delay, kind: "state", payload: state(chatId, engine: engine, cwd: cwd, phase: "generating")),
        ]
        steps += stream("用户想要一个覆盖 reset 路径的测试。先读 OutputSequencer.swift，确认 reset 清掉了哪些状态，再决定断言。",
                        variant: "agent_thought_chunk", delayMs: delay)
        steps += stream(answer, variant: "agent_message_chunk", delayMs: delay)
        steps += [
            .emit(delayMs: delay * 4, kind: "update", payload: update([
                "sessionUpdate": "tool_call", "toolCallId": edit, "title": "编辑 OutputSequencerTests.swift",
                "kind": "edit", "status": "pending",
                "locations": [["path": "CCPanesTests/OutputSequencerTests.swift", "line": 52]],
                "content": [["type": "diff", "path": "CCPanesTests/OutputSequencerTests.swift",
                             "oldText": "    }\n}", "newText": "    }\n\n    func testResetClearsPending() {\n        var s = OutputSequencer()\n        s.reset()\n    }\n}"]],
            ])),
            .emit(delayMs: delay * 2, kind: "permission_request", payload: .from([
                "requestKey": key,
                "params": ["sessionId": "mock-session",
                           "toolCall": ["toolCallId": edit, "title": "编辑 OutputSequencerTests.swift", "kind": "edit",
                                        "locations": [["path": "CCPanesTests/OutputSequencerTests.swift"]]],
                           "options": [["optionId": "allow", "name": "允许", "kind": "allow_once"],
                                       ["optionId": "always", "name": "始终允许", "kind": "allow_always"],
                                       ["optionId": "reject", "name": "拒绝", "kind": "reject_once"]]],
            ])),
            .awaitPermission(requestKey: key),
            .emit(delayMs: delay * 3, kind: "update", payload: update(["sessionUpdate": "tool_call_update",
                                                                        "toolCallId": edit, "status": "completed"])),
            .emit(delayMs: delay * 3, kind: "update", payload: update([
                "sessionUpdate": "tool_call", "toolCallId": run, "title": "xcodebuild test -only-testing OutputSequencerTests",
                "kind": "execute", "status": "in_progress", "rawInput": ["command": "xcodebuild test"],
            ])),
            .emit(delayMs: delay * 8, kind: "update", payload: update([
                "sessionUpdate": "tool_call_update", "toolCallId": run, "status": "completed",
                "content": [["type": "content", "content": ["type": "text",
                                                            "text": "Test Suite 'OutputSequencerTests' passed.\n Executed 6 tests, with 0 failures"]]],
            ])),
            .emit(delayMs: delay * 2, kind: "update", payload: update(["sessionUpdate": "plan", "entries": [
                ["content": "阅读 OutputSequencer.reset 实现", "priority": "high", "status": "completed"],
                ["content": "新增 testResetClearsPending", "priority": "high", "status": "completed"],
                ["content": "补 UTF-8 边界用例", "priority": "low", "status": "pending"],
            ]])),
        ]
        steps += stream(summary, variant: "agent_message_chunk", delayMs: delay)
        steps += [
            .emit(delayMs: delay, kind: "update", payload: update(["sessionUpdate": "usage_update", "used": 48_200, "size": 200_000])),
            .emit(delayMs: delay, kind: "turn_ended", payload: .from(["stopReason": "end_turn"])),
            .emit(delayMs: 0, kind: "state", payload: state(chatId, engine: engine, cwd: cwd, phase: "ready")),
        ]
        return steps
    }

    /// 用户在 mock 对话里发的新消息：`user_prompt` 回显（同 promptId，客户端据此去重）+ 简短回复。
    static func reply(chatId: String, engine: String, cwd: String, prompt: String,
                      promptId: String, config: [String: String] = [:]) -> [Step] {
        var steps: [Step] = [
            .emit(delayMs: 0, kind: "user_prompt", payload: userPrompt(prompt, promptId: promptId, origin: "mobile")),
            .emit(delayMs: 0, kind: "state", payload: state(chatId, engine: engine, cwd: cwd, phase: "generating", config: config)),
        ]
        steps += stream("收到：「\(prompt)」。这是 mock 模式下的演示回复，没有连接真实 agent。", variant: "agent_message_chunk", delayMs: 40)
        steps += [
            .emit(delayMs: 50, kind: "turn_ended", payload: .from(["stopReason": "end_turn"])),
            .emit(delayMs: 0, kind: "state", payload: state(chatId, engine: engine, cwd: cwd, phase: "ready", config: config)),
        ]
        return steps
    }
}
