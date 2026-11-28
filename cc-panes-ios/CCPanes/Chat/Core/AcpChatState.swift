import Foundation

/// 纯 reducer：事件环（WS 帧）→ 对话条目 + 审批/提问队列 + 快照。
/// 与桌面 useAgentChatStore / agentChatEvents.ts 同语义；无 IO、无时间依赖，可单测。
struct AcpChatState: Sendable, Equatable {
    var snapshot: AcpChatSnapshot?
    var items: [ChatItem] = []
    var pendingPermissions: [PendingPermission] = []
    var pendingQuestions: [PendingQuestion] = []
    /// 已应用的最大 seq（续传用 afterSeq）。
    var lastSeq = 0
    /// 收到 `synchronized` 后为 true：补发完毕、之后均为实时。
    var synchronized = false
    var availableCommands: [String] = []
    var usage: AcpUsage?
    var terminals: [String: AcpTerminalOutput] = [:]
    /// 当前回合（generating 期间）是否在跑；由 state / turn_ended 驱动。
    var phase: AcpChatPhase { snapshot?.phase ?? .other("") }

    struct Replay: Sendable, Equatable {
        var acpSessionId: String
        var prefixLength: Int
        var items: [ChatItem] = []
    }
    /// session/load 历史回放暂存：commit 才替换正文，abort 丢弃。
    var replay: Replay?

    private var nextId = 0

    init(snapshot: AcpChatSnapshot? = nil) { self.snapshot = snapshot }

    /// 当前停靠卡：审批优先，同一时刻只一张。
    var dockedCard: DockedCard? {
        if let p = pendingPermissions.first { return .permission(p) }
        if let q = pendingQuestions.first { return .question(q) }
        return nil
    }

    // MARK: - Frames

    /// 应用一帧。返回 false = 重复帧（seq 已应用）被丢弃。
    @discardableResult
    mutating func apply(_ frame: AcpFrame) -> Bool {
        switch frame {
        case .event(let event): return apply(event)
        case .reset(let snapshot, let floorSeq):
            reset(snapshot: snapshot, floorSeq: floorSeq)
            return true
        case .synchronized(let seq):
            synchronized = true
            lastSeq = max(lastSeq, seq)
            return true
        case .closed:
            synchronized = false
            return true
        }
    }

    /// 应用一条事件；seq ≤ lastSeq 的重复帧丢弃（服务端补发与实时流交界处可能重叠）。
    @discardableResult
    mutating func apply(_ event: AcpEvent) -> Bool {
        guard event.seq > lastSeq else { return false }
        lastSeq = event.seq
        dispatch(kind: event.kind, payload: event.payload)
        return true
    }

    /// `reset`：afterSeq 已被裁剪 → 清空正文，套用快照，从 floorSeq 起重放。
    /// floorSeq = 环内保留的最小 seq（§3.2），故 lastSeq 置 floorSeq-1，floorSeq 那条照常应用。
    mutating func reset(snapshot raw: JSONValue, floorSeq: Int) {
        items = []
        pendingPermissions = []
        pendingQuestions = []
        terminals = [:]
        replay = nil
        synchronized = false
        if raw.object != nil { snapshot = AcpChatSnapshot(raw) }
        lastSeq = max(0, floorSeq - 1)
        if let error = snapshot?.error { push(.notice(error)) }
    }

    /// 本地乐观插入用户消息（发送时调用）。服务端的 `user_prompt`（同 promptId）只做确认不重复插入；
    /// 适配器若再回显 user_message_chunk 也会被 echoRemaining 吞掉。
    mutating func addLocalUser(_ text: String, promptId: String? = nil) {
        closeOpenThought()
        items.append(ChatItem(id: makeId(), kind: .user(text), echoRemaining: text,
                              promptId: promptId, origin: "mobile", promptPending: promptId != nil))
    }

    /// `user_prompt {promptId, blocks, origin}`：任一入口发出的用户消息。
    private mutating func applyUserPrompt(_ payload: JSONValue) {
        let promptId = payload["promptId"]?.string
        if let promptId, let i = items.lastIndex(where: { $0.promptId == promptId }) {
            items[i].promptPending = false
            return
        }
        let text = (payload["blocks"]?.array ?? []).map { Self.contentText($0) }.joined()
        guard !text.isEmpty else { return }
        closeOpenThought()
        // echoRemaining：同一 prompt 若再经 user_message_chunk 回显，按文本吞掉不重复。
        let item = ChatItem(id: makeId(), kind: .user(text), echoRemaining: replay == nil ? text : nil,
                            promptId: promptId, origin: payload["origin"]?.string)
        mutateContent { $0.append(item) }
    }

    mutating func pushNotice(_ text: String) { push(.notice(text)) }

    // MARK: - Dispatch

    private mutating func dispatch(kind: String, payload: JSONValue) {
        switch kind {
        case "update": applyUpdate(payload)
        case "state": applyState(payload)
        case "permission_request":
            guard let key = payload["requestKey"]?.string else { return }
            let request = PendingPermission(requestKey: key, params: payload["params"] ?? .null)
            if let i = pendingPermissions.firstIndex(where: { $0.requestKey == key }) {
                pendingPermissions[i] = request
            } else {
                pendingPermissions.append(request)
            }
        case "user_prompt": applyUserPrompt(payload)
        case "permission_resolved":
            guard let key = payload["requestKey"]?.string else { return }
            // 别处（电脑 / 其他设备）先处理了：收卡并留一条可见记录。本机正在回复的不提示。
            if let card = pendingPermissions.first(where: { $0.requestKey == key }), !card.responding {
                let by = payload["by"]?.string
                let verdict = payload["optionId"]?.string == nil ? "取消" : "处理"
                push(.notice("「\(card.title)」已在\(AcpOrigin.label(by))端\(verdict)"))
            }
            resolvePermission(key)
        case "elicitation_request":
            guard let key = payload["requestKey"]?.string,
                  !pendingQuestions.contains(where: { $0.requestKey == key }) else { return }
            pendingQuestions.append(PendingQuestion(requestKey: key, params: payload["params"] ?? .null))
        case "elicitation_cancelled", "elicitation_resolved":
            if let key = payload["requestKey"]?.string { resolveQuestion(key) }
        case "turn_ended": applyTurnEnded(payload)
        case "history_replay": applyHistoryReplay(payload)
        case "terminal_output": applyTerminalOutput(payload)
        case "notification": applyNotification(payload)
        case "protocol_noise": return // 适配器杂音，桌面同样不进消息流
        // Bot 外部来源（IM / 组网）的投递公告；同一条消息另有 user_prompt（同 promptId）负责上屏。
        case "external_prompt": return
        default: pushOnce("[ACP] 未处理的事件类型: \(kind)")
        }
    }

    mutating func resolvePermission(_ key: String) {
        pendingPermissions.removeAll { $0.requestKey == key }
    }

    mutating func resolveQuestion(_ key: String) {
        pendingQuestions.removeAll { $0.requestKey == key }
    }

    private mutating func applyState(_ payload: JSONValue) {
        guard payload.object != nil else { return }
        let next = AcpChatSnapshot(payload)
        let previousError = snapshot?.error
        if [.starting, .exited, .failed].contains(next.phase) {
            pendingPermissions = []
            pendingQuestions = []
        }
        if next.phase == .starting { usage = nil }
        if next.phase.isTerminal { replay = nil }
        snapshot = next
        if let error = next.error, error != previousError { push(.notice(error)) }
    }

    private mutating func applyTurnEnded(_ payload: JSONValue) {
        // 回合结束后审批卡必然失效（agent 已用 cancelled 收场）。
        pendingPermissions = []
        pendingQuestions = []
        closeOpenThought()
        let reason = payload["stopReason"]?.string ?? "end_turn"
        if reason != "end_turn" {
            let error = payload["error"]?.string
            push(.notice(error.map { "\(Self.stopReasonLabel(reason))：\($0)" } ?? Self.stopReasonLabel(reason)))
        }
    }

    static func stopReasonLabel(_ reason: String) -> String {
        switch reason {
        case "cancelled": "已取消本轮"
        case "max_tokens": "输出达到长度上限"
        case "max_turn_requests": "达到单轮请求上限"
        case "refusal": "agent 拒绝了此请求"
        default: "[\(reason)]"
        }
    }

    private mutating func applyHistoryReplay(_ payload: JSONValue) {
        guard let sessionId = payload["acpSessionId"]?.string else { return }
        switch payload["phase"]?.string {
        case "begin":
            replay = Replay(acpSessionId: sessionId, prefixLength: items.count)
        case "commit":
            guard let r = replay, r.acpSessionId == sessionId else { return }
            items = Array(items.prefix(r.prefixLength)) + r.items
            replay = nil
        case "abort":
            if replay?.acpSessionId == sessionId { replay = nil }
        default:
            return
        }
    }

    private mutating func applyTerminalOutput(_ payload: JSONValue) {
        guard let id = payload["terminalId"]?.string else { return }
        terminals[id] = AcpTerminalOutput(terminalId: id, output: payload["output"]?.string ?? "",
                                          truncated: payload["truncated"]?.bool ?? false,
                                          exitCode: payload["exitStatus"]?["exitCode"]?.int)
    }

    private mutating func applyNotification(_ payload: JSONValue) {
        switch payload["method"]?.string {
        case "ccpanes/load-failed", "ccpanes/load-unsupported":
            // 续接降级必须可见：静默降级 = 用户以为上下文还在。
            push(.notice("未能续接历史对话，已开始新会话"))
        case "ccpanes/auto-approved":
            let call = payload["params"]?["toolCall"] ?? .null
            let kind = payload["resolvedKind"]?.string ?? call["kind"]?.string ?? "other"
            let label = AcpToolCall.kindLabel(kind)
            if let title = call["title"]?.string, !title.isEmpty {
                push(.notice("已自动放行：\(title)（\(label)）"))
            } else {
                push(.notice("已自动放行一次\(label)操作"))
            }
        default:
            return
        }
    }

    // MARK: - Item plumbing（AcpChatState+Update 共用）

    mutating func makeId() -> String {
        nextId += 1
        return "i\(nextId)"
    }

    /// 回放未确认前只写暂存区，让旧画面保持可读。
    mutating func mutateContent(_ body: (inout [ChatItem]) -> Void) {
        if replay != nil { body(&replay!.items) } else { body(&items) }
    }

    var contentItems: [ChatItem] { replay?.items ?? items }

    mutating func push(_ kind: ChatItem.Kind, parent: String? = nil) {
        if case .thought = kind {} else { closeOpenThought() }
        let item = ChatItem(id: makeId(), kind: kind, parentToolCallId: parent)
        mutateContent { $0.append(item) }
    }

    /// 同文案的提示只出现一次（未知协议变体探针，避免刷屏）。
    mutating func pushOnce(_ text: String) {
        guard !contentItems.contains(where: { $0.kind == .notice(text) }) else { return }
        push(.notice(text))
    }

    mutating func closeOpenThought() {
        mutateContent { items in
            guard let last = items.indices.last, case .thought(let text, false) = items[last].kind else { return }
            items[last].kind = .thought(text, done: true)
        }
    }
}
