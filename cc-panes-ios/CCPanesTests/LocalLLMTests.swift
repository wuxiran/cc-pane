import XCTest
@testable import CCPanes

/// 手机本地会话（docs/112 §6）：SSE 分帧、两种协议解码、请求构建、持久化、密钥只进钥匙串、导入解码。
final class SSEParserTests: XCTestCase {
    func testSplitChunksCRLFAndMultibyte() {
        var parser = SSEParser()
        let raw = "event: message_start\r\ndata: {\"a\":\"你好\"}\r\n\r\n: comment\n\ndata: line1\ndata: line2\n\n"
        let bytes = Array(raw.utf8)
        var events: [SSEEvent] = []
        // 每 3 字节一片：切开 CRLF、切开中文的 UTF-8 序列
        for start in stride(from: 0, to: bytes.count, by: 3) {
            events += parser.feed(bytes[start..<min(start + 3, bytes.count)])
        }
        events += parser.finish()
        XCTAssertEqual(events, [
            SSEEvent(event: "message_start", data: "{\"a\":\"你好\"}"),
            SSEEvent(event: nil, data: "line1\nline2"),
        ])
    }

    func testFinishFlushesUnterminatedEvent() {
        var parser = SSEParser()
        XCTAssertTrue(parser.feed("data: [DONE]").isEmpty)
        XCTAssertEqual(parser.finish(), [SSEEvent(event: nil, data: "[DONE]")])
    }

    func testFieldWithoutSpaceAndUnknownFields() {
        var parser = SSEParser()
        let events = parser.feed("id: 1\nretry: 10\ndata:x\n\n")
        XCTAssertEqual(events, [SSEEvent(event: nil, data: "x")])
    }
}

final class StreamDecoderTests: XCTestCase {
    func testAnthropicFullStream() throws {
        var decoder = AnthropicStreamDecoder()
        var deltas: [LLMDelta] = []
        for data in [
            #"{"type":"message_start","message":{"model":"claude-opus-5-5","usage":{"input_tokens":10,"cache_read_input_tokens":5,"output_tokens":1}}}"#,
            #"{"type":"ping"}"#,
            #"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"嗯"}}"#,
            #"{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hi"}}"#,
            #"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}"#,
            #"{"type":"message_stop"}"#,
        ] {
            deltas += try decoder.decode(SSEEvent(event: nil, data: data))
        }
        XCTAssertEqual(deltas, [.model("claude-opus-5-5"), .usage(input: 15, output: 1), .thinking("嗯"), .text("Hi"),
                                .stop("end_turn"), .usage(input: nil, output: 7)])
        XCTAssertTrue(decoder.finished)
    }

    func testAnthropicErrorEvent() {
        var decoder = AnthropicStreamDecoder()
        XCTAssertThrowsError(try decoder.decode(SSEEvent(event: "error",
            data: #"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#))) { error in
            XCTAssertEqual(error as? LLMError, .api(type: "overloaded_error", message: "Overloaded"))
            XCTAssertTrue((error as? LLMError)?.errorDescription?.contains("过载") == true)
        }
    }

    func testOpenAIStreamWithUsageAndDone() throws {
        var decoder = OpenAIStreamDecoder()
        var deltas: [LLMDelta] = []
        for data in [
            #"{"model":"gpt-x","choices":[{"delta":{"role":"assistant","content":""}}]}"#,
            #"{"model":"gpt-x","choices":[{"delta":{"reasoning_content":"想"}}]}"#,
            #"{"model":"gpt-x","choices":[{"delta":{"content":"你好"},"finish_reason":null}]}"#,
            #"{"model":"gpt-x","choices":[{"delta":{},"finish_reason":"stop"}]}"#,
            #"{"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4}}"#,
            "[DONE]",
        ] {
            deltas += try decoder.decode(SSEEvent(event: nil, data: data))
        }
        XCTAssertEqual(deltas, [.model("gpt-x"), .thinking("想"), .text("你好"), .stop("stop"), .usage(input: 3, output: 4)])
        XCTAssertTrue(decoder.finished)
    }

    func testOpenAIErrorPayload() {
        var decoder = OpenAIStreamDecoder()
        XCTAssertThrowsError(try decoder.decode(SSEEvent(event: nil, data: #"{"error":{"message":"bad model","type":"invalid_request_error"}}"#))) {
            XCTAssertEqual($0 as? LLMError, .api(type: "invalid_request_error", message: "bad model"))
        }
    }

    func testErrorMessagesAreChinese() {
        XCTAssertEqual(LLMError.http(status: 401, message: "").errorDescription, "API Key 无效或已过期（401）")
        XCTAssertTrue(LLMError.from(URLError(.timedOut)) == .timeout)
        XCTAssertTrue(LLMError.from(URLError(.cancelled)) == .cancelled)
        XCTAssertEqual(LLMError.message(fromBody: Data(#"{"error":{"message":"nope"}}"#.utf8)), "nope")
        XCTAssertEqual(LLMError.message(fromBody: Data("<html>502</html>".utf8)), "")
    }
}

final class LLMClientTests: XCTestCase {
    func testEndpoints() throws {
        XCTAssertEqual(try LLMClient.endpoint(kind: .anthropic, baseURL: "https://api.anthropic.com/").absoluteString,
                       "https://api.anthropic.com/v1/messages")
        XCTAssertEqual(try LLMClient.endpoint(kind: .anthropic, baseURL: "https://relay.x/v1").absoluteString,
                       "https://relay.x/v1/messages")
        XCTAssertEqual(try LLMClient.endpoint(kind: .openaiChat, baseURL: "https://api.openai.com/v1").absoluteString,
                       "https://api.openai.com/v1/chat/completions")
        XCTAssertEqual(try LLMClient.endpoint(kind: .openaiChat, baseURL: "https://x/v1/chat/completions").absoluteString,
                       "https://x/v1/chat/completions")
        XCTAssertEqual(try LLMClient.modelsEndpoint(kind: .anthropic, baseURL: "https://a.b").absoluteString, "https://a.b/v1/models")
        XCTAssertEqual(try LLMClient.modelsEndpoint(kind: .openaiChat, baseURL: "https://a.b/v1").absoluteString, "https://a.b/v1/models")
        XCTAssertThrowsError(try LLMClient.endpoint(kind: .anthropic, baseURL: "not a url"))
        XCTAssertThrowsError(try LLMClient.endpoint(kind: .anthropic, baseURL: "ftp://x"))
    }

    func testAnthropicRequestShape() throws {
        let request = try LLMClient.makeRequest(LLMRequest(
            kind: .anthropic, baseURL: "https://api.anthropic.com", apiKey: "sk-a", model: "claude-opus-5-5",
            system: "be brief", turns: [.init(role: .user, text: "hi")]))
        XCTAssertEqual(request.value(forHTTPHeaderField: "x-api-key"), "sk-a")
        XCTAssertEqual(request.value(forHTTPHeaderField: "anthropic-version"), "2023-06-01")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"), "官方域名只带 x-api-key")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: request.httpBody!) as? [String: Any])
        XCTAssertEqual(body["system"] as? String, "be brief")
        XCTAssertEqual(body["stream"] as? Bool, true)
        XCTAssertEqual(body["model"] as? String, "claude-opus-5-5")
        XCTAssertNil(body["temperature"])

        let relay = try LLMClient.makeRequest(LLMRequest(kind: .anthropic, baseURL: "https://relay.example", apiKey: "sk-r",
                                                         model: "m", turns: []))
        XCTAssertEqual(relay.value(forHTTPHeaderField: "Authorization"), "Bearer sk-r", "中转站同时带 Bearer")
    }

    func testOpenAIRequestShape() throws {
        let request = try LLMClient.makeRequest(LLMRequest(
            kind: .openaiChat, baseURL: "https://api.openai.com/v1", apiKey: "sk-o", model: "gpt",
            system: "sys", turns: [.init(role: .user, text: "q"), .init(role: .assistant, text: "a"), .init(role: .user, text: "q2")]))
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer sk-o")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: request.httpBody!) as? [String: Any])
        let messages = try XCTUnwrap(body["messages"] as? [[String: String]])
        XCTAssertEqual(messages.map { $0["role"]! }, ["system", "user", "assistant", "user"])
        XCTAssertEqual((body["stream_options"] as? [String: Bool])?["include_usage"], true)
    }

    func testMissingKeyThrows() {
        XCTAssertThrowsError(try LLMClient.makeRequest(LLMRequest(kind: .anthropic, baseURL: "https://a.b", apiKey: "",
                                                                   model: "m", turns: []))) {
            XCTAssertEqual($0 as? LLMError, .missingKey)
        }
    }

    func testStreamsThroughMockForBothProtocols() async throws {
        let client = MockLLMProtocol.client()
        for (kind, base) in [(LLMProtocol.anthropic, "https://mock.llm"), (.openaiChat, "https://mock.llm/v1")] {
            var text = ""
            var usage = LLMUsage()
            for try await delta in client.stream(LLMRequest(kind: kind, baseURL: base, apiKey: "k", model: "m",
                                                            turns: [.init(role: .user, text: "测试")])) {
                if case .text(let t) = delta { text += t }
                if case .usage(let i, let o) = delta { usage.merge(input: i, output: o) }
            }
            XCTAssertTrue(text.contains("你说的是：「测试」"), "\(kind): \(text)")
            XCTAssertTrue(text.contains("```swift"))
            XCTAssertNotNil(usage.outputTokens)
        }
    }

    func testHTTPErrorAndStreamErrorMapping() async {
        let client = MockLLMProtocol.client()
        do {
            for try await _ in client.stream(LLMRequest(kind: .anthropic, baseURL: "https://mock.llm", apiKey: "k", model: "m",
                                                        turns: [.init(role: .user, text: "#401")])) {}
            XCTFail("应当抛出 401")
        } catch {
            XCTAssertEqual(error as? LLMError, .http(status: 401, message: "invalid x-api-key"))
        }
        do {
            for try await _ in client.stream(LLMRequest(kind: .openaiChat, baseURL: "https://mock.llm/v1", apiKey: "k", model: "m",
                                                        turns: [.init(role: .user, text: "#overloaded")])) {}
            XCTFail("应当抛出流内错误")
        } catch {
            XCTAssertEqual(error as? LLMError, .api(type: "overloaded_error", message: "Overloaded"))
        }
    }

    func testParseModels() throws {
        let models = try LLMClient.parseModels(Data(#"{"data":[{"id":"a","display_name":"A"},{"id":""},{"id":"b"}]}"#.utf8))
        XCTAssertEqual(models, [LocalModel(id: "a", label: "A"), LocalModel(id: "b", label: nil)])
    }
}

@MainActor
final class LocalStoreTests: XCTestCase {
    private func tempDir() -> URL {
        FileManager.default.temporaryDirectory.appending(path: "local-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
    }

    func testKeychainStoreUsesDedicatedServiceAndThisDeviceOnly() {
        let store = KeychainSecretStore(service: LocalProviderStore.keychainService)
        let attrs = store.addAttributes("sk", account: "p1")
        XCTAssertEqual(attrs[kSecAttrService as String] as? String, "com.ccpanes.ios.llm-key")
        XCTAssertEqual(attrs[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
    }

    func testProviderKeysNeverHitTheFile() throws {
        let dir = tempDir()
        let secrets = MemorySecretStore()
        let store = LocalProviderStore(directory: dir, secrets: secrets)
        let provider = LocalProvider(id: "p1", name: "Relay", kind: .anthropic, baseURL: "https://relay.x",
                                     models: [LocalModel(id: "m1")])
        try store.save(provider, apiKey: "  sk-super-secret  ")
        XCTAssertEqual(secrets.all["p1"], "sk-super-secret")
        let file = try String(contentsOf: store.fileURL, encoding: .utf8)
        XCTAssertFalse(file.contains("sk-super-secret"))
        XCTAssertTrue(file.contains("Relay"))

        let reloaded = LocalProviderStore(directory: dir, secrets: secrets)
        XCTAssertEqual(reloaded.providers.map(\.id), ["p1"])
        XCTAssertTrue(reloaded.hasKey("p1"))
        XCTAssertEqual(reloaded.apiKey(for: "p1"), "sk-super-secret")

        try reloaded.save(provider, apiKey: nil) // 不改密钥
        XCTAssertEqual(secrets.all["p1"], "sk-super-secret")
        reloaded.delete("p1")
        XCTAssertNil(secrets.all["p1"])
        XCTAssertTrue(reloaded.providers.isEmpty)
    }

    /// 与 Rust `ExportPayload` 的 serde 输出同形（camelCase、`protocol`）。
    static let payloadJSON = #"""
    {"version":1,"exportedAt":"2026-11-27T10:00:00+00:00",
     "providers":[
       {"id":"relay","name":"My Relay","providerType":"proxy","protocol":"anthropic","baseUrl":"https://relay.example.com",
        "models":[{"id":"claude-opus-5-5","label":"Opus"}],"defaultModelId":"claude-opus-5-5","apiKey":"sk-relay"},
       {"id":"oai","name":"OAI","providerType":"open_ai","protocol":"openai_chat","baseUrl":"https://oai.example.com/v1",
        "models":[],"apiKey":"sk-oai"}],
     "skipped":[{"id":"bed","name":"Bedrock","reason":"UNSUPPORTED_TYPE"}]}
    """#

    func testImportDecodingAndUpsert() throws {
        let payload = try JSONDecoder().decode(ProviderExportPayload.self, from: Data(Self.payloadJSON.utf8))
        XCTAssertEqual(payload.providers.count, 2)
        XCTAssertEqual(payload.providers[0].protocolKind, "anthropic")
        XCTAssertFalse(payload.description.contains("sk-relay"))
        XCTAssertFalse(payload.providers[0].description.contains("sk-relay"))

        let secrets = MemorySecretStore()
        let store = LocalProviderStore(directory: tempDir(), secrets: secrets)
        let first = try store.importPayload(payload, computerName: "Mac mini")
        XCTAssertEqual(first.added, ["My Relay", "OAI"])
        XCTAssertEqual(first.skipped.first?.name, "Bedrock")
        let relay = try XCTUnwrap(store.providers.first { $0.originId == "relay" })
        XCTAssertEqual(relay.kind, .anthropic)
        XCTAssertEqual(relay.sourceComputer, "Mac mini")
        XCTAssertEqual(relay.defaultModelId, "claude-opus-5-5")
        XCTAssertEqual(secrets.all[relay.id], "sk-relay")
        XCTAssertEqual(store.providers.first { $0.originId == "oai" }?.kind, .openaiChat)

        // 同一台电脑再导入一次：覆盖不新增
        let second = try store.importPayload(payload, computerName: "Mac mini")
        XCTAssertEqual(second.updated, ["My Relay", "OAI"])
        XCTAssertEqual(store.providers.count, 2)
        XCTAssertFalse(try String(contentsOf: store.fileURL, encoding: .utf8).contains("sk-"))
    }

    func testExportClientRequestAndErrorMapping() throws {
        let target = ProviderImportTarget(id: "c1", name: "Mac", baseURL: URL(string: "http://192.168.1.2:18080")!,
                                          token: "ccp_dev_abc")
        let request = try ProviderExportClient.request(target: target, code: "123 456")
        XCTAssertEqual(request.url?.absoluteString, "http://192.168.1.2:18080/api/providers/export")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer ccp_dev_abc")
        XCTAssertEqual(try JSONSerialization.jsonObject(with: request.httpBody!) as? [String: String], ["code": "123456"])
        XCTAssertThrowsError(try ProviderExportClient.request(target: target, code: "12"))

        func mapped(_ status: Int, _ body: String) -> ProviderImportError? {
            do { _ = try ProviderExportClient.parse(status: status, data: Data(body.utf8)); return nil } catch {
                return error as? ProviderImportError
            }
        }
        XCTAssertEqual(mapped(400, #"{"code":"EXPORT_CODE_INVALID","attemptsLeft":3}"#), .wrongCode(attemptsLeft: 3))
        XCTAssertEqual(mapped(410, #"{"code":"EXPORT_CODE_EXPIRED"}"#), .expired)
        XCTAssertEqual(mapped(429, #"{"code":"EXPORT_CODE_LOCKED"}"#), .locked)
        XCTAssertEqual(mapped(429, #"{"code":"EXPORT_RATE_LIMITED"}"#), .rateLimited)
        XCTAssertEqual(mapped(403, #"{"code":"DEVICE_TOKEN_REQUIRED"}"#), .needsPairing)
        XCTAssertEqual(mapped(403, #"{"code":"READ_ONLY"}"#), .readOnly)
        XCTAssertEqual(mapped(503, #"{"code":"ACP_HOST_UNAVAILABLE"}"#), .desktopNotRunning)
        XCTAssertEqual(mapped(404, ""), .unsupported)
        XCTAssertNoThrow(try ProviderExportClient.parse(status: 200, data: Data(Self.payloadJSON.utf8)))
    }

    func testChatLifecyclePersistsAndStreams() async throws {
        let dir = tempDir()
        let providers = LocalProviderStore(directory: dir, secrets: MemorySecretStore())
        try providers.save(LocalProvider(id: "p", name: "Mock", kind: .anthropic, baseURL: "https://mock.llm",
                                         models: [LocalModel(id: "claude-opus-5-5")]), apiKey: "k")
        let chats = LocalChatStore(directory: dir.appending(path: "chats"), providers: providers, client: MockLLMProtocol.client())
        let chat = chats.create(providerId: "p", modelId: "claude-opus-5-5")
        XCTAssertTrue(chats.send(chat.id, text: "  帮我写一段很长很长的标题测试文字，超过二十四个字符的那种  \n第二行"))
        XCTAssertFalse(chats.send(chat.id, text: "再来"), "生成中不能再发")
        for _ in 0..<200 where chats.isGenerating(chat.id) { try await Task.sleep(for: .milliseconds(25)) }
        XCTAssertFalse(chats.isGenerating(chat.id))

        let done = try XCTUnwrap(chats.chat(chat.id))
        XCTAssertTrue(done.title.hasPrefix("帮我写一段很长很长的标题测试文字"))
        XCTAssertTrue(done.title.hasSuffix("…"))
        let reply = try XCTUnwrap(done.messages.last)
        XCTAssertEqual(reply.role, .assistant)
        XCTAssertTrue(reply.text.contains("模拟回复"))
        XCTAssertNil(reply.error)
        XCTAssertEqual(reply.usage?.inputTokens, 42)
        XCTAssertEqual(reply.usage?.outputTokens, 87)
        XCTAssertEqual(reply.stopReason, "end_turn")

        // 落盘 + 重载
        let reloaded = LocalChatStore(directory: dir.appending(path: "chats"), providers: providers, client: MockLLMProtocol.client())
        XCTAssertEqual(reloaded.chat(chat.id)?.messages.count, 2)
        XCTAssertEqual(reloaded.listItems.first?.computerId, LocalChatListItem.computerId)
        XCTAssertFalse(try String(contentsOf: reloaded.fileURL(chat.id), encoding: .utf8).contains("\"k\""))

        reloaded.rename(chat.id, to: "改过的名字")
        XCTAssertEqual(reloaded.chat(chat.id)?.title, "改过的名字")
        reloaded.delete(chat.id)
        XCTAssertNil(reloaded.chat(chat.id))
        XCTAssertFalse(FileManager.default.fileExists(atPath: reloaded.fileURL(chat.id).path()))
    }

    func testErrorThenRetryAndCancel() async throws {
        let dir = tempDir()
        let providers = LocalProviderStore(directory: dir, secrets: MemorySecretStore())
        try providers.save(LocalProvider(id: "p", name: "Mock", kind: .openaiChat, baseURL: "https://mock.llm/v1",
                                         models: [LocalModel(id: "gpt-mock")]), apiKey: "k")
        let chats = LocalChatStore(directory: dir.appending(path: "chats"), providers: providers, client: MockLLMProtocol.client())
        let chat = chats.create(providerId: "p", modelId: "gpt-mock")
        chats.send(chat.id, text: "#401")
        for _ in 0..<200 where chats.isGenerating(chat.id) { try await Task.sleep(for: .milliseconds(25)) }
        XCTAssertTrue(chats.chat(chat.id)?.messages.last?.error?.contains("401") == true)
        XCTAssertTrue(chats.listItems.first?.hasError == true)

        // 失败那轮的用户消息会与下一条合并进历史；停止用另开的对话验证
        let slow = chats.create(providerId: "p", modelId: "gpt-mock")
        chats.send(slow.id, text: "#slow 慢一点")
        try await Task.sleep(for: .milliseconds(300))
        chats.cancel(slow.id)
        for _ in 0..<200 where chats.isGenerating(slow.id) { try await Task.sleep(for: .milliseconds(25)) }
        let last = chats.chat(slow.id)?.messages.last
        XCTAssertEqual(last?.cancelled, true, "\(String(describing: last))")
        XCTAssertNil(last?.error)
    }

    func testNormalizeMergesConsecutiveUserTurns() {
        let turns = LocalChatStore.normalize([.init(role: .user, text: "a"), .init(role: .user, text: "b"),
                                              .init(role: .assistant, text: "c")])
        XCTAssertEqual(turns, [.init(role: .user, text: "a\n\nb"), .init(role: .assistant, text: "c")])
    }

    func testAutoTitle() {
        XCTAssertEqual(LocalChat.autoTitle(from: "\n\n  hello   world \nnext"), "hello world")
        XCTAssertEqual(LocalChat.autoTitle(from: "   "), LocalChat.untitled)
    }

    func testUnifiedSearchFindsLocalChats() {
        let item = LocalChatListItem(id: "x", title: "旅行计划", preview: "去京都", updatedAt: .now, providerName: "Relay",
                                     modelId: "m", isGenerating: false, hasError: false)
        let sections = UnifiedSearch.results("京都", in: UnifiedSearch.Corpus(local: [item]))
        guard case .local(let hit)? = sections.first?.hits.first else { return XCTFail("应命中本机对话") }
        XCTAssertEqual(hit.id, "x")
        XCTAssertEqual(sections.first?.hits.first?.destination,
                       .chat(ChatRoute(chatId: "x", title: "旅行计划", engineId: "local", computerId: LocalChatListItem.computerId)))
    }
}
