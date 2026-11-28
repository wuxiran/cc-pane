import Foundation

/// `/api/acp/*` REST 客户端。复用 APIClient 的服务器地址与鉴权（设备令牌 Bearer / Cookie），
/// 自带 URLSession 以便把 503/403 映射成 AcpError（APIClient 的 send 不对外）。
final class AcpClient: AcpService {
    private let api: APIClient
    private let session: URLSession

    init(api: APIClient) {
        self.api = api
        let config = URLSessionConfiguration.default
        config.httpCookieStorage = api.cookies
        config.httpShouldSetCookies = true
        config.timeoutIntervalForRequest = 20
        DirectRoute.configure(config, for: api.baseURL)
        session = URLSession(configuration: config)
    }

    func engines() async throws -> [AcpEngineInfo] { try await get("/api/acp/engines") }
    func chats() async throws -> [AcpChatSummary] { try await get("/api/acp/chats") }
    func history() async throws -> [AcpHistoryEntry] { try await get("/api/acp/history") }

    func create(engineId: String, cwd: String, resumeAcpSessionId: String?) async throws -> AcpChatSnapshot {
        var body: [String: JSONValue] = ["engineId": .string(engineId), "cwd": .string(cwd)]
        if let resumeAcpSessionId { body["resumeAcpSessionId"] = .string(resumeAcpSessionId) }
        let value: JSONValue = try await send("POST", "/api/acp/chats", body: .object(body))
        return AcpChatSnapshot.parseDetail(value).0
    }

    func detail(chatId: String) async throws -> (AcpChatSnapshot, Int?) {
        let value: JSONValue = try await get(chatPath(chatId))
        return AcpChatSnapshot.parseDetail(value)
    }

    func prompt(chatId: String, text: String, promptId: String) async throws {
        try await post(chatId, "prompt", Self.promptBody(text: text, promptId: promptId))
    }

    /// `{blocks, promptId}`：promptId 由客户端生成，服务端随 `user_prompt` 事件回带，用来抵消本地回显。
    static func promptBody(text: String, promptId: String) -> JSONValue {
        let blocks: JSONValue = .array([.object(["type": .string("text"), "text": .string(text)])])
        return .object(["blocks": blocks, "promptId": .string(promptId)])
    }

    func cancel(chatId: String) async throws { try await post(chatId, "cancel", .object([:])) }
    func setMode(chatId: String, modeId: String) async throws { try await post(chatId, "mode", .object(["modeId": .string(modeId)])) }
    func setModel(chatId: String, modelId: String) async throws { try await post(chatId, "model", .object(["modelId": .string(modelId)])) }

    func setConfigOption(chatId: String, configId: String, value: String) async throws {
        try await post(chatId, "config", .object(["configId": .string(configId), "value": .string(value)]))
    }

    func respondPermission(chatId: String, requestKey: String, optionId: String?) async throws {
        var body: [String: JSONValue] = ["requestKey": .string(requestKey)]
        // optionId 缺省 = 取消（同桌面 respond_acp_permission 的 null）。
        body["optionId"] = optionId.map(JSONValue.string) ?? .null
        try await post(chatId, "permission", .object(body))
    }

    func respondElicitation(chatId: String, requestKey: String, response: JSONValue) async throws {
        try await post(chatId, "elicitation", .object(["requestKey": .string(requestKey), "response": response]))
    }

    func stop(chatId: String) async throws {
        let _: JSONValue = try await send("DELETE", chatPath(chatId), body: nil)
    }

    func openStream(chatId: String, afterSeq: Int) async -> AsyncStream<AcpFrame> {
        AcpSocket(request: socketRequest(chatId: chatId, afterSeq: afterSeq)).open()
    }

    // MARK: - Plumbing

    private func chatPath(_ chatId: String) -> String {
        "/api/acp/chats/\(chatId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? chatId)"
    }

    func socketRequest(chatId: String, afterSeq: Int) -> URLRequest {
        api.webSocketRequest(path: "/ws/acp/\(chatId)",
                             query: [URLQueryItem(name: "afterSeq", value: String(afterSeq))])
    }

    private func post(_ chatId: String, _ action: String, _ body: JSONValue) async throws {
        let _: JSONValue = try await send("POST", "\(chatPath(chatId))/\(action)", body: body)
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        try await send("GET", path, body: nil)
    }

    private func send<T: Decodable>(_ method: String, _ path: String, body: JSONValue?) async throws -> T {
        // chatPath 已做百分号编码；用字符串拼接避免 appending(path:) 二次编码。
        guard let url = URL(string: api.baseURL.absoluteString + path) else { throw AcpError.other("地址无效") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        api.authorize(&request)
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.network(error.localizedDescription)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        switch status {
        case 200..<300: break
        case 401: throw api.unauthorizedError()
        default: throw AcpError.from(status: status, body: data)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data.isEmpty ? Data("null".utf8) : data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }
}
