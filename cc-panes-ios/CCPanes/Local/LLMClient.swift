import Foundation

/// 一次对话请求（已解析好的密钥 / 地址 / 历史）。
struct LLMRequest: Sendable {
    struct Turn: Sendable, Equatable {
        var role: LocalMessage.Role
        var text: String
    }

    var kind: LLMProtocol
    var baseURL: String
    var apiKey: String
    var model: String
    var system: String?
    var turns: [Turn]
    var maxTokens = 8192
    /// OpenAI：请求末尾带用量（`stream_options.include_usage`）。不认的中转会 400，客户端自动去掉重试一次。
    var includeUsage = true
}

/// 直连 LLM API 的流式客户端。只做 HTTP + SSE，不持有状态；`session` 可注入（单测 / `-localMock` 用 URLProtocol 桩）。
final class LLMClient: Sendable {
    let session: URLSession

    init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.default
            config.timeoutIntervalForRequest = 120 // 首个字节前的等待（长思考模型）
            config.timeoutIntervalForResource = 30 * 60
            config.waitsForConnectivity = false
            config.urlCache = nil
            self.session = URLSession(configuration: config)
        }
    }

    // MARK: - 请求构建（纯函数）

    /// Anthropic 根地址 → `/v1/messages`；已带 `/v1` 或完整路径的原样补齐。
    static func endpoint(kind: LLMProtocol, baseURL: String) throws -> URL {
        var base = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        while base.hasSuffix("/") { base.removeLast() }
        let path: String
        switch kind {
        case .anthropic:
            if base.hasSuffix("/v1/messages") { path = "" }
            else if base.hasSuffix("/v1") { path = "/messages" }
            else { path = "/v1/messages" }
        case .openaiChat:
            path = base.hasSuffix("/chat/completions") ? "" : "/chat/completions"
        }
        guard let url = URL(string: base + path), let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http", url.host() != nil else {
            throw LLMError.invalidURL(baseURL)
        }
        return url
    }

    /// 模型列表接口：Anthropic `{root}/v1/models`，OpenAI `{v1}/models`。
    static func modelsEndpoint(kind: LLMProtocol, baseURL: String) throws -> URL {
        let messages = try endpoint(kind: kind, baseURL: baseURL).absoluteString
        let root = kind == .anthropic
            ? String(messages.dropLast("/messages".count))
            : String(messages.dropLast("/chat/completions".count))
        guard let url = URL(string: root + "/models") else { throw LLMError.invalidURL(baseURL) }
        return url
    }

    /// 鉴权头。Anthropic 官方只认 `x-api-key`；第三方中转（Claude Code 的 ANTHROPIC_AUTH_TOKEN 生态）
    /// 多认 `Authorization: Bearer`，非官方域名两个都带。
    static func authorize(_ request: inout URLRequest, kind: LLMProtocol, apiKey: String) {
        switch kind {
        case .anthropic:
            request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
            request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
            if request.url?.host()?.lowercased() != "api.anthropic.com" {
                request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
            }
        case .openaiChat:
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        }
    }

    static func makeRequest(_ request: LLMRequest) throws -> URLRequest {
        guard !request.apiKey.isEmpty else { throw LLMError.missingKey }
        var urlRequest = URLRequest(url: try endpoint(kind: request.kind, baseURL: request.baseURL))
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        authorize(&urlRequest, kind: request.kind, apiKey: request.apiKey)
        let system = request.system?.trimmingCharacters(in: .whitespacesAndNewlines)
        var body: [String: Any] = ["model": request.model, "stream": true]
        switch request.kind {
        case .anthropic:
            body["max_tokens"] = request.maxTokens
            body["messages"] = request.turns.map { ["role": $0.role.rawValue, "content": $0.text] }
            if let system, !system.isEmpty { body["system"] = system }
        case .openaiChat:
            var messages: [[String: String]] = []
            if let system, !system.isEmpty { messages.append(["role": "system", "content": system]) }
            messages += request.turns.map { ["role": $0.role.rawValue, "content": $0.text] }
            body["messages"] = messages
            if request.includeUsage { body["stream_options"] = ["include_usage": true] }
        }
        urlRequest.httpBody = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        return urlRequest
    }

    // MARK: - 流式

    /// 发请求并按增量吐出；取消（停止按钮 / 离开页面）经 `onTermination` 取消底层任务。
    func stream(_ request: LLMRequest) -> AsyncThrowingStream<LLMDelta, Error> {
        let session = self.session
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    do {
                        try await Self.run(request, session: session, continuation: continuation)
                    } catch LLMError.http(400, let message)
                        where request.kind == .openaiChat && request.includeUsage && message.contains("stream_options") {
                        var retry = request
                        retry.includeUsage = false
                        try await Self.run(retry, session: session, continuation: continuation)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: LLMError.from(error))
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private static func run(_ request: LLMRequest, session: URLSession,
                            continuation: AsyncThrowingStream<LLMDelta, Error>.Continuation) async throws {
        let urlRequest = try makeRequest(request)
        let (bytes, response) = try await session.bytes(for: urlRequest)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            var body = Data()
            for try await byte in bytes {
                body.append(byte)
                if body.count >= 64 * 1024 { break }
            }
            throw LLMError.http(status: status, message: LLMError.message(fromBody: body))
        }
        var parser = SSEParser()
        var anthropic = AnthropicStreamDecoder()
        var openai = OpenAIStreamDecoder()
        var line: [UInt8] = []
        var sawEvent = false
        func handle(_ events: [SSEEvent]) throws {
            for event in events {
                sawEvent = true
                let deltas = request.kind == .anthropic ? try anthropic.decode(event) : try openai.decode(event)
                for delta in deltas { continuation.yield(delta) }
            }
        }
        for try await byte in bytes {
            line.append(byte)
            if byte == 0x0A {
                try handle(parser.feed(line))
                line.removeAll(keepingCapacity: true)
            }
            if anthropic.finished || openai.finished { break }
        }
        if !line.isEmpty { try handle(parser.feed(line)) }
        try handle(parser.finish())
        try Task.checkCancellation()
        if !sawEvent { throw LLMError.emptyResponse }
    }

    // MARK: - 模型列表

    /// 拉服务端模型列表（`/models`）。不是所有中转都实现，失败由调用方提示。
    func listModels(kind: LLMProtocol, baseURL: String, apiKey: String) async throws -> [LocalModel] {
        var request = URLRequest(url: try Self.modelsEndpoint(kind: kind, baseURL: baseURL))
        request.timeoutInterval = 20
        Self.authorize(&request, kind: kind, apiKey: apiKey)
        let (data, response): (Data, URLResponse)
        do { (data, response) = try await session.data(for: request) } catch { throw LLMError.from(error) }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw LLMError.http(status: status, message: LLMError.message(fromBody: data))
        }
        return try Self.parseModels(data)
    }

    /// `{data:[{id, display_name?}]}`（两家同形；Anthropic 多 display_name）。
    static func parseModels(_ data: Data) throws -> [LocalModel] {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = object["data"] as? [[String: Any]] else { throw LLMError.decoding("模型列表格式不对") }
        return list.compactMap { item in
            guard let id = item["id"] as? String, !id.isEmpty else { return nil }
            return LocalModel(id: id, label: item["display_name"] as? String)
        }
    }
}
