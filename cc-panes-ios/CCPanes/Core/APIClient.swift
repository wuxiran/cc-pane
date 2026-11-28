import Foundation

enum APIError: LocalizedError, Sendable {
    case network(String)
    case unauthorized
    /// 带设备令牌却被拒（令牌已吊销 / 过期）。
    case tokenRejected
    case forbidden(String)
    case http(Int, String)
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .network(let m): "网络请求失败：\(m)"
        case .unauthorized: "会话已过期，请重新登录"
        case .tokenRejected: "令牌失效，请重新配对"
        case .forbidden(let m): m.isEmpty ? "访问被拒绝" : m
        case .http(let code, let m): m.isEmpty ? "HTTP \(code)" : m
        case .decoding(let m): "响应解析失败：\(m)"
        }
    }

    var isNetwork: Bool { if case .network = self { true } else { false } }
}

/// 单个服务器的 REST 客户端。鉴权二选一：配对得到的设备令牌（REST `Authorization: Bearer`，
/// WS `?token=`，docs/111），或 Cookie（ccp_web_session，按域名隔离，WS 握手时手动带上）。
final class APIClient: Sendable {
    let baseURL: URL
    let cookies: HTTPCookieStorage
    /// `ccp_dev_…` 设备令牌；nil = 走 Cookie / 免登录。
    let token: String?
    private let session: URLSession
    private let onTokenRejected: (@Sendable () -> Void)?

    init(baseURL: URL, token: String? = nil, onTokenRejected: (@Sendable () -> Void)? = nil) {
        self.baseURL = baseURL
        self.token = token
        self.onTokenRejected = onTokenRejected
        cookies = HTTPCookieStorage.shared
        let config = URLSessionConfiguration.default
        config.httpCookieStorage = cookies
        config.httpShouldSetCookies = true
        config.timeoutIntervalForRequest = 15
        config.waitsForConnectivity = false
        DirectRoute.configure(config, for: baseURL)
        session = URLSession(configuration: config)
    }

    // MARK: - Auth

    func authStatus() async throws -> AuthStatus {
        try await get("/api/auth/status")
    }

    /// 设备信息（名称 / 版本）；需鉴权。
    func deviceInfo() async throws -> DeviceInfo { try await get("/api/device/info") }

    func login(username: String, password: String) async throws {
        struct Body: Encodable { let username: String; let password: String }
        let _: EmptyResponse = try await send("POST", "/api/auth/login", body: Body(username: username, password: password))
    }

    // MARK: - Sessions

    func sessions() async throws -> [SessionInfo] { try await get("/api/sessions") }

    func launchHistory(limit: Int = 300) async throws -> [LaunchRecord] {
        try await get("/api/launch-history", query: [URLQueryItem(name: "limit", value: String(limit))])
    }

    func workspaces() async throws -> [Workspace] { try await get("/api/workspaces") }

    /// 电脑前端布局快照；桌面从未落库时后端返回 null → nil。
    func layoutSnapshot(profileId: String) async throws -> LayoutSnapshot? {
        try await get("/api/layout-snapshot/\(profileId)")
    }

    /// 最近 N 行纯文本输出（ANSI 已剥离，卡片预览用）。
    func sessionOutput(_ id: String, lines: Int = 2) async throws -> [String] {
        struct Output: Decodable { var lines: [String]? }
        let output: Output? = try await get("/api/sessions/\(id)/output",
                                            query: [URLQueryItem(name: "lines", value: String(lines))])
        return output?.lines ?? []
    }

    func recoverySnapshot(_ id: String) async throws -> RecoverySnapshot? {
        try await get("/api/sessions/\(id)/recovery-snapshot")
    }

    func replaySnapshot(_ id: String) async throws -> ReplaySnapshot? {
        try await get("/api/sessions/\(id)/snapshot")
    }

    /// 新建会话；返回 sessionId。cliTool=none 时为纯终端。
    /// resumeId 非空时恢复该 CLI 历史对话。
    func createSession(projectPath: String, workspaceName: String?, cliTool: CliTool,
                       resumeId: String? = nil, cols: Int, rows: Int) async throws -> String {
        struct Body: Encodable {
            let projectPath: String; let workspaceName: String?
            let cliTool: String; let launchClaude: Bool
            let resumeId: String?
            let cols: Int; let rows: Int
        }
        struct Created: Decodable { let sessionId: String }
        let body = Body(projectPath: projectPath, workspaceName: workspaceName,
                        cliTool: cliTool.rawValue, launchClaude: cliTool != .none,
                        resumeId: resumeId, cols: cols, rows: rows)
        let created: Created = try await send("POST", "/api/sessions", body: body)
        return created.sessionId
    }

    func killSession(_ id: String) async throws {
        let _: EmptyResponse = try await send("DELETE", "/api/sessions/\(id)", body: Optional<EmptyBody>.none)
    }

    // MARK: - WebSocket

    /// /ws/{id} 的握手请求。
    func terminalSocketRequest(sessionId: String) -> URLRequest {
        webSocketRequest(path: "/ws/\(sessionId)")
    }

    /// WS 握手请求：ws(s) 地址；有设备令牌时追加 `?token=`（服务端只对 /ws/ 路径认查询参数），
    /// 否则带 Cookie 头（URLSession 不会给 ws:// 自动带 cookie）。
    func webSocketRequest(path: String, query: [URLQueryItem] = []) -> URLRequest {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.scheme = baseURL.scheme == "https" ? "wss" : "ws"
        components.path = path
        var items = query
        if let token { items.append(URLQueryItem(name: "token", value: token)) }
        components.queryItems = items.isEmpty ? nil : items
        // `+` 在查询里可能被当空格：令牌只含 [A-Za-z0-9_-]，这里仅防御性编码。
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        var request = URLRequest(url: components.url!)
        request.timeoutInterval = 10
        if token == nil {
            let header = HTTPCookie.requestHeaderFields(with: cookies.cookies(for: baseURL) ?? [])
            for (key, value) in header { request.setValue(value, forHTTPHeaderField: key) }
        }
        return request
    }

    /// REST 请求加鉴权头。
    func authorize(_ request: inout URLRequest) {
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    }

    /// 401 的统一出口：带令牌 = 令牌失效（通知上层回到配对），否则 = 登录过期。
    func unauthorizedError() -> APIError {
        guard token != nil else { return .unauthorized }
        onTokenRejected?()
        return .tokenRejected
    }

    // MARK: - Plumbing

    private struct EmptyBody: Encodable {}
    private struct EmptyResponse: Decodable {}

    private func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        try await send("GET", path, query: query, body: Optional<EmptyBody>.none)
    }

    private func send<T: Decodable, B: Encodable>(_ method: String, _ path: String, query: [URLQueryItem] = [], body: B?) async throws -> T {
        var components = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        authorize(&request)
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.network(error.localizedDescription)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        switch status {
        case 200..<300: break
        case 401: throw unauthorizedError()
        case 403: throw APIError.forbidden(Self.message(from: data))
        default: throw APIError.http(status, Self.message(from: data))
        }
        if T.self == EmptyResponse.self { return EmptyResponse() as! T }
        // 后端对「无快照」等返回 JSON null；Optional<T> 解码直接得到 nil。
        do {
            return try JSONDecoder().decode(T.self, from: data.isEmpty ? Data("null".utf8) : data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    private static func message(from data: Data) -> String {
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let m = obj["message"] as? String { return m }
        return String(data: data, encoding: .utf8) ?? ""
    }
}
