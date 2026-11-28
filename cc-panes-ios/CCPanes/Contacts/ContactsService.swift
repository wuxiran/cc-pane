import Foundation
import UIKit

/// 通讯录后端抽象（docs/112 §5）。真实实现按 §5.5「本机 Bot + 各已配对设备的 `/api/bots`」：
/// 手机对地址簿里每台电脑各自探测择优、带该电脑的设备令牌拉目录；对话直接连那台电脑的
/// `/ws/acp/bot-{id}`，发消息走它的 `POST /api/bots/{id}/messages`。
/// 所有路径 / 字段名只出现在本文件与 `BotContact.parse`——后端改名是单文件改动。
protocol ContactsService: Sendable {
    /// 通讯录里有哪些电脑（真实 = 地址簿；mock = fixture）。
    @MainActor func nodes(computers: [Computer], currentId: String?) -> [ContactNode]
    /// 拉一台电脑的 Bot 目录；不抛错，失败归入 `NodeDirectory.status`。
    func directory(of node: ContactNode) async -> NodeDirectory
    /// 与某个 Bot 对话用的 AcpService（连到 Bot 所在电脑）；电脑不可达返回 nil。
    func chatService(for contact: BotContact, node: ContactNode) async -> (any AcpService)?
    /// 能否从手机改 Bot 的远程策略（§5.2 `PATCH /api/bots/{id}`）。
    var canEditPolicy: Bool { get }
    /// 一轮刷新开始（真实实现借机清掉其他电脑的线路缓存，地址可能在局域网 ↔ Tailscale 间变了）。
    func beginRefresh() async
    /// 改远程策略；返回服务端回的最新条目（拿不到时 nil，调用方本地套用改动）。
    func update(_ change: BotRemoteChange, for contact: BotContact, node: ContactNode) async throws -> BotContact?
}

/// 契约路径（§5.2）。
enum ContactsAPI {
    static let bots = "/api/bots"
    static func messages(_ botId: String) -> String { "/api/bots/\(encode(botId))/messages" }
    static func bot(_ botId: String) -> String { "/api/bots/\(encode(botId))" }
    static let chats = "/api/acp/chats"
    static let policyEditEnabled = true

    static func encode(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
    }

    /// `POST /api/bots/{id}/messages` 请求体：`{text, promptId, from:{device}}`（hops/traceId 缺省 =
    /// 人发起、服务端生成）。promptId 原样进 `user_prompt`，手机据此抵消本地回显；来源以令牌为准。
    static func messageBody(text: String, promptId: String, device: String) -> JSONValue {
        .object(["text": .string(text), "promptId": .string(promptId),
                 "from": .object(["device": .string(device)])])
    }
}

// MARK: - Live

final class LiveContactsService: ContactsService {
    /// 电脑 id → 已连上的客户端（复用 ConnectionHub 的常驻连接；离线 = nil）。
    typealias Resolver = @Sendable (String) async -> (APIClient, AddressBook.Kind)?

    private let resolver: Resolver
    private let deviceName: String

    init(resolver: @escaping Resolver, deviceName: String) {
        self.resolver = resolver
        self.deviceName = deviceName
    }

    var canEditPolicy: Bool { ContactsAPI.policyEditEnabled }

    @MainActor
    func nodes(computers: [Computer], currentId: String?) -> [ContactNode] {
        computers.map { ContactNode(computer: $0, currentId: currentId) }
    }

    func directory(of node: ContactNode) async -> NodeDirectory {
        guard let (client, via) = await client(for: node) else { return NodeDirectory(status: .offline) }
        let http = ContactsHTTP(api: client)
        async let botsValue = http.get(ContactsAPI.bots)
        async let chatsValue = try? http.get(ContactsAPI.chats)
        do {
            var bots = BotContact.parseList(try await botsValue, nodeId: node.id)
            let chats = (await chatsValue)?.decode([AcpChatSummary].self) ?? []
            for i in bots.indices {
                if let chat = chats.first(where: { $0.chatId == bots[i].chatId || $0.botId == bots[i].botId }) {
                    bots[i].merge(chat: chat)
                }
            }
            return NodeDirectory(status: .online, bots: bots, via: via)
        } catch let error as ContactsHTTPError {
            return NodeDirectory(status: error.nodeStatus, via: via)
        } catch {
            return NodeDirectory(status: .error(error.localizedDescription), via: via)
        }
    }

    func chatService(for contact: BotContact, node: ContactNode) async -> (any AcpService)? {
        guard let (client, _) = await client(for: node) else { return nil }
        let http = ContactsHTTP(api: client)
        let device = deviceName
        let base = AcpClient(api: client)
        return BotChatService(base: base, botChatId: contact.chatId) { text, promptId in
            do {
                _ = try await http.send("POST", ContactsAPI.messages(contact.botId),
                                        body: ContactsAPI.messageBody(text: text, promptId: promptId, device: device))
            } catch ContactsHTTPError.status(404, code: let code, message: _) where code != "BOT_NOT_FOUND" {
                // 电脑端还没有 §5.2 接口：Bot 对话已在跑时退回 ACP prompt（同一条 chat）。
                try await base.prompt(chatId: contact.chatId, text: text, promptId: promptId)
            }
        }
    }

    func update(_ change: BotRemoteChange, for contact: BotContact, node: ContactNode) async throws -> BotContact? {
        guard canEditPolicy, let (client, _) = await client(for: node) else {
            throw ContactsHTTPError.network("连不上「\(node.name)」")
        }
        let value = try await ContactsHTTP(api: client).send("PATCH", ContactsAPI.bot(contact.botId), body: change.body)
        guard var updated = BotContact.parse(value, nodeId: node.id) else { return nil }
        // PATCH 回的是 SharedBot，不含对话态：沿用列表里合并来的那份。
        updated.pendingPermissions = contact.pendingPermissions
        updated.lastSeq = contact.lastSeq
        updated.updatedAt = contact.updatedAt
        if updated.status == nil { updated.status = contact.status }
        return updated
    }

    private func client(for node: ContactNode) async -> (APIClient, AddressBook.Kind)? { await resolver(node.id) }

    func beginRefresh() async {}
}

// MARK: - HTTP

enum ContactsHTTPError: LocalizedError, Sendable, Equatable {
    case network(String)
    case unauthorized
    case status(Int, code: String?, message: String)

    var errorDescription: String? {
        switch self {
        case .network(let m): "网络请求失败：\(m)"
        case .unauthorized: "令牌失效，请重新配对"
        case .status(let s, let code, let m):
            Self.message(code: code) ?? (s == 503 ? "电脑端 CC-Panes 未运行" : (m.isEmpty ? "HTTP \(s)" : m))
        }
    }

    /// §5.2 错误码 → 中文提示（未知码回落服务端 message）。
    static func message(code: String?) -> String? {
        switch code {
        case "BOT_NOT_FOUND": "这个 Bot 已不存在（可能已在电脑端删除）"
        case "BOT_REMOTE_DENIED": "这个 Bot 没有对其他设备共享，无法远程发消息"
        case "BOT_FULL_CONFIRM_REQUIRED": "开启「完全信任」需要二次确认"
        case "MESH_HOPS_EXCEEDED": "转发层数超过上限（最多 3 跳），消息未送达"
        case "MESH_LOOP_DETECTED": "检测到 Bot 之间的消息回环，已拦截"
        case "MESH_BUSY": "这个 Bot 手上的消息太多了，请稍后再试"
        case "ACP_PROMPT_REQUIRED": "消息不能为空"
        case "ACP_HOST_UNAVAILABLE": "电脑端 CC-Panes 未运行"
        default: nil
        }
    }

    var nodeStatus: NodeStatus {
        switch self {
        case .network: .offline
        case .unauthorized: .tokenRejected
        case .status(404, _, _): .unsupported
        case .status(503, _, _): .hostUnavailable
        default: .error(errorDescription ?? "")
        }
    }
}

/// 极薄的 JSON over HTTP：复用 APIClient 的地址与鉴权（Bearer / Cookie）与 DirectRoute。
struct ContactsHTTP: Sendable {
    let api: APIClient

    func get(_ path: String) async throws -> JSONValue { try await send("GET", path, body: nil) }

    func send(_ method: String, _ path: String, body: JSONValue?) async throws -> JSONValue {
        guard let url = URL(string: api.baseURL.absoluteString + path) else { throw ContactsHTTPError.network("地址无效") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = method == "GET" ? 8 : 30
        api.authorize(&request)
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = api.cookies
        config.httpShouldSetCookies = true
        DirectRoute.configure(config, for: api.baseURL)
        let session = URLSession(configuration: config)
        defer { session.finishTasksAndInvalidate() }
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw ContactsHTTPError.network(error.localizedDescription)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let value = (try? JSONDecoder().decode(JSONValue.self, from: data)) ?? .null
        switch status {
        case 200..<300: return value
        case 401: throw ContactsHTTPError.unauthorized
        default:
            throw ContactsHTTPError.status(status, code: value["code"]?.string ?? value["error"]?.string,
                                           message: value["message"]?.string ?? "")
        }
    }
}

// MARK: - Bot 对话

/// Bot 对话 = 那台电脑上 `chatId = bot-{id}` 的 ACP chat（复用 ChatScreen / AcpChatSession）。
/// 与普通对话的两处不同：
/// 1. 发消息走 `POST /api/bots/{id}/messages`（远程策略、按需拉起 Bot 都在服务端）；
/// 2. Bot 还没启动时事件环不存在（WS / 详情 404）：先「空闲在线」等着，发出第一条后再连。
final class BotChatService: AcpService {
    typealias Sender = @Sendable (_ text: String, _ promptId: String) async throws -> Void

    private let base: any AcpService
    private let botChatId: String
    private let sender: Sender
    private let wake = WakeSignal()
    /// 未启动时多久复查一次（电脑端从别处拉起了 Bot）。
    private let dormantPoll: Duration

    init(base: any AcpService, botChatId: String, dormantPoll: Duration = .seconds(5), sender: @escaping Sender) {
        self.base = base
        self.botChatId = botChatId
        self.dormantPoll = dormantPoll
        self.sender = sender
    }

    func engines() async throws -> [AcpEngineInfo] { try await base.engines() }
    func chats() async throws -> [AcpChatSummary] { try await base.chats() }
    func history() async throws -> [AcpHistoryEntry] { try await base.history() }
    func create(engineId: String, cwd: String, resumeAcpSessionId: String?) async throws -> AcpChatSnapshot {
        try await base.create(engineId: engineId, cwd: cwd, resumeAcpSessionId: resumeAcpSessionId)
    }
    func detail(chatId: String) async throws -> (AcpChatSnapshot, Int?) { try await base.detail(chatId: chatId) }

    func prompt(chatId: String, text: String, promptId: String) async throws {
        do {
            try await sender(text, promptId)
        } catch let error as ContactsHTTPError {
            if case .status(503, _, _) = error { throw AcpError.hostUnavailable }
            throw AcpError.other(error.localizedDescription)
        }
        await wake.fire()
    }

    func cancel(chatId: String) async throws { try await base.cancel(chatId: chatId) }
    func setMode(chatId: String, modeId: String) async throws { try await base.setMode(chatId: chatId, modeId: modeId) }
    func setModel(chatId: String, modelId: String) async throws { try await base.setModel(chatId: chatId, modelId: modelId) }
    func setConfigOption(chatId: String, configId: String, value: String) async throws {
        try await base.setConfigOption(chatId: chatId, configId: configId, value: value)
    }
    func respondPermission(chatId: String, requestKey: String, optionId: String?) async throws {
        try await base.respondPermission(chatId: chatId, requestKey: requestKey, optionId: optionId)
    }
    func respondElicitation(chatId: String, requestKey: String, response: JSONValue) async throws {
        try await base.respondElicitation(chatId: chatId, requestKey: requestKey, response: response)
    }
    func stop(chatId: String) async throws { try await base.stop(chatId: chatId) }

    func openStream(chatId: String, afterSeq: Int) async -> AsyncStream<AcpFrame> {
        let (stream, continuation) = AsyncStream<AcpFrame>.makeStream()
        let base = self.base, wake = self.wake, poll = self.dormantPoll
        let task = Task {
            var announcedIdle = false
            while !Task.isCancelled {
                var synchronized = false
                var dormant = false
                for await frame in await base.openStream(chatId: chatId, afterSeq: afterSeq) {
                    switch frame {
                    case .closed(let status) where status == 404 && !synchronized:
                        dormant = true
                    case .synchronized:
                        synchronized = true
                        continuation.yield(frame)
                    default:
                        continuation.yield(frame)
                    }
                    if dormant { break }
                }
                guard dormant else { break }
                // Bot 未启动：对会话而言是「已同步、无内容」，输入框可用；发出第一条或定时复查后重连。
                if !announcedIdle {
                    announcedIdle = true
                    continuation.yield(.synchronized(lastSeq: afterSeq))
                }
                await wake.wait(timeout: poll)
            }
            continuation.finish()
        }
        continuation.onTermination = { _ in task.cancel() }
        return stream
    }
}

/// 一次性唤醒：`wait` 在 `fire` 或超时后返回。
actor WakeSignal {
    private var waiters: [UUID: CheckedContinuation<Void, Never>] = [:]

    func fire() {
        let all = waiters
        waiters.removeAll()
        for continuation in all.values { continuation.resume() }
    }

    func wait(timeout: Duration) async {
        let id = UUID()
        let timer = Task { [weak self] in
            try? await Task.sleep(for: timeout)
            await self?.resume(id)
        }
        await withCheckedContinuation { continuation in waiters[id] = continuation }
        timer.cancel()
    }

    private func resume(_ id: UUID) {
        waiters.removeValue(forKey: id)?.resume()
    }
}
