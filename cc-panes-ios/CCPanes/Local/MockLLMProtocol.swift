#if DEBUG
import Foundation

/// 进程内 LLM 桩（`-localMock YES` 与单测）：按路径回放 Anthropic / OpenAI 的 SSE，
/// 分多片、带延迟写出（覆盖跨片切行 / 切多字节字符）。不发任何真实网络请求。
///
/// 用户消息里的指令：`#401` → HTTP 401；`#overloaded` → 流内 error 事件；`#slow` → 每片 0.4s（演示停止）。
final class MockLLMProtocol: URLProtocol, @unchecked Sendable {
    private let lock = NSLock()
    private var stopped = false

    static func client() -> LLMClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockLLMProtocol.self]
        return LLMClient(session: URLSession(configuration: config))
    }

    @MainActor
    static func seed(_ store: LocalProviderStore) {
        // mock 用内存密钥：每次启动都要补上（元数据文件会留着）
        guard store.providers.isEmpty else {
            for (id, key) in [("mock-claude", "sk-mock-anthropic"), ("mock-openai", "sk-mock-openai")] {
                if let provider = store.provider(id), !store.hasKey(id) { try? store.save(provider, apiKey: key) }
            }
            return
        }
        try? store.save(LocalProvider(
            id: "mock-claude", name: "Mock Claude", kind: .anthropic, baseURL: "https://mock.llm",
            models: [LocalModel(id: "claude-opus-5-5", label: "Claude Opus 5.5"), LocalModel(id: "claude-haiku-5-5")],
            defaultModelId: "claude-opus-5-5", sourceComputer: "Mock Mac"), apiKey: "sk-mock-anthropic")
        try? store.save(LocalProvider(
            id: "mock-openai", name: "Mock OpenAI", kind: .openaiChat, baseURL: "https://mock.llm/v1",
            models: [LocalModel(id: "gpt-mock")], defaultModelId: "gpt-mock"), apiKey: "sk-mock-openai")
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let request = self.request
        let path = request.url?.path() ?? ""
        let prompt = Self.lastUserText(Self.body(of: request))
        if path.hasSuffix("/models") {
            respond(status: 200, contentType: "application/json",
                    chunks: [Data(#"{"data":[{"id":"mock-model-a","display_name":"Mock A"},{"id":"mock-model-b"}]}"#.utf8)], delay: 0)
            return
        }
        if prompt.contains("#401") {
            respond(status: 401, contentType: "application/json",
                    chunks: [Data(#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#.utf8)], delay: 0)
            return
        }
        let anthropic = path.hasSuffix("/v1/messages")
        let reply = Self.reply(for: prompt)
        let sse = anthropic ? Self.anthropicSSE(reply, overloaded: prompt.contains("#overloaded"))
                            : Self.openAISSE(reply, overloaded: prompt.contains("#overloaded"))
        // 故意按 7 字节切片：会切开中文字符与 `data:` 行。
        let bytes = Array(sse.utf8)
        let chunks = stride(from: 0, to: bytes.count, by: 7).map { Data(bytes[$0..<min($0 + 7, bytes.count)]) }
        respond(status: 200, contentType: "text/event-stream", chunks: chunks, delay: prompt.contains("#slow") ? 0.4 : 0.003)
    }

    override func stopLoading() {
        lock.withLock { stopped = true }
    }

    private var isStopped: Bool { lock.withLock { stopped } }

    private func respond(status: Int, contentType: String, chunks: [Data], delay: TimeInterval) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": contentType])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        send(chunks[...], delay: delay)
    }

    private func send(_ chunks: ArraySlice<Data>, delay: TimeInterval) {
        guard !isStopped else { return }
        guard let first = chunks.first else {
            client?.urlProtocolDidFinishLoading(self)
            return
        }
        client?.urlProtocol(self, didLoad: first)
        let rest = chunks.dropFirst()
        if delay == 0 { return send(rest, delay: 0) }
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [self] in send(rest, delay: delay) }
    }

    static func body(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }

    static func lastUserText(_ body: Data) -> String {
        guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let messages = object["messages"] as? [[String: Any]] else { return "" }
        return messages.last { $0["role"] as? String == "user" }?["content"] as? String ?? ""
    }

    static func reply(for prompt: String) -> String {
        let quoted = prompt.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        return """
        这是**手机本地会话**的模拟回复（未联网）。你说的是：「\(quoted)」。

        - 直连供应商 API，不经过电脑
        - 支持 `Markdown` 与代码块

        ```swift
        let reply = "你好，iPhone"
        ```
        """
    }

    static func anthropicSSE(_ text: String, overloaded: Bool) -> String {
        var out = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-opus-5-5\",\"usage\":{\"input_tokens\":42,\"output_tokens\":1}}}\n\n"
        out += "event: ping\ndata: {\"type\":\"ping\"}\n\n"
        if overloaded {
            return out + "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n"
        }
        out += "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n"
        for piece in pieces(text) {
            out += "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\(json(piece))}}\n\n"
        }
        out += "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n"
        out += "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":87}}\n\n"
        out += "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
        return out
    }

    static func openAISSE(_ text: String, overloaded: Bool) -> String {
        if overloaded { return "data: {\"error\":{\"message\":\"Overloaded\",\"type\":\"overloaded_error\"}}\n\n" }
        var out = ""
        for piece in pieces(text) {
            out += "data: {\"model\":\"gpt-mock\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\(json(piece))},\"finish_reason\":null}]}\n\n"
        }
        out += "data: {\"model\":\"gpt-mock\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"
        out += "data: {\"model\":\"gpt-mock\",\"choices\":[],\"usage\":{\"prompt_tokens\":31,\"completion_tokens\":64}}\n\n"
        out += "data: [DONE]\n\n"
        return out
    }

    private static func pieces(_ text: String) -> [String] {
        var result: [String] = []
        var current = ""
        for char in text {
            current.append(char)
            if current.count >= 4 { result.append(current); current = "" }
        }
        if !current.isEmpty { result.append(current) }
        return result
    }

    private static func json(_ string: String) -> String {
        let data = try? JSONSerialization.data(withJSONObject: [string], options: [.fragmentsAllowed])
        let array = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
        return String(array.dropFirst().dropLast())
    }
}
#endif
