import Foundation

// 流式协议解析（纯函数 / 值类型，便于单测）：SSE 分帧 → 两种协议的事件解码 → LLMDelta。

/// 一条 SSE 事件（`event:` + 合并后的 `data:`）。
struct SSEEvent: Equatable, Sendable {
    var event: String?
    var data: String
}

/// 增量 SSE 解析器：按**字节**切行（`\r\n` 在 Swift String 里是一个字符，按字符切不到；
/// 且多字节 UTF-8 可能被网络分片切开——只在行尾解码就不会坏字）。空行分派事件，
/// `:` 开头为注释，多条 `data:` 以 `\n` 连接（WHATWG EventSource 规则）。
struct SSEParser: Sendable {
    private var line: [UInt8] = []
    private var eventName: String?
    private var dataLines: [String] = []

    mutating func feed<S: Sequence>(_ bytes: S) -> [SSEEvent] where S.Element == UInt8 {
        var events: [SSEEvent] = []
        for byte in bytes {
            if byte == 0x0A {
                if line.last == 0x0D { line.removeLast() }
                if let event = process(String(decoding: line, as: UTF8.self)) { events.append(event) }
                line.removeAll(keepingCapacity: true)
            } else {
                line.append(byte)
            }
        }
        return events
    }

    mutating func feed(_ text: String) -> [SSEEvent] { feed(Array(text.utf8)) }

    /// 流结束：残留的半行与未以空行收尾的事件一并分派。
    mutating func finish() -> [SSEEvent] {
        var events: [SSEEvent] = []
        if !line.isEmpty {
            if line.last == 0x0D { line.removeLast() }
            if let event = process(String(decoding: line, as: UTF8.self)) { events.append(event) }
            line.removeAll()
        }
        if let event = dispatch() { events.append(event) }
        return events
    }

    private mutating func process(_ text: String) -> SSEEvent? {
        if text.isEmpty { return dispatch() }
        if text.hasPrefix(":") { return nil }
        let field: Substring
        var value: Substring
        if let colon = text.firstIndex(of: ":") {
            field = text[..<colon]
            value = text[text.index(after: colon)...]
            if value.first == " " { value = value.dropFirst() }
        } else {
            field = Substring(text)
            value = ""
        }
        switch field {
        case "event": eventName = String(value)
        case "data": dataLines.append(String(value))
        default: break // id / retry：对一次性请求无意义
        }
        return nil
    }

    private mutating func dispatch() -> SSEEvent? {
        defer { eventName = nil; dataLines = [] }
        guard !dataLines.isEmpty else { return nil }
        return SSEEvent(event: eventName, data: dataLines.joined(separator: "\n"))
    }
}

/// 两种协议统一后的增量。
enum LLMDelta: Equatable, Sendable {
    case text(String)
    case thinking(String)
    case usage(input: Int?, output: Int?)
    case stop(String?)
    case model(String)
}

/// 错误（用户可见文案为中文）。
enum LLMError: LocalizedError, Equatable, Sendable {
    case missingKey
    case invalidURL(String)
    case http(status: Int, message: String)
    /// 流内错误事件（Anthropic `event: error` / OpenAI `{"error":…}`）。
    case api(type: String?, message: String)
    case network(String)
    case timeout
    case cancelled
    case emptyResponse
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .missingKey: return "这个供应商还没有 API Key，请在「本机模型」里补上"
        case .invalidURL(let url): return "接口地址无效：\(url)"
        case .http(let status, let message):
            let detail = message.isEmpty ? "" : "：\(message)"
            switch status {
            case 400: return "请求被拒绝（400）\(detail)"
            case 401: return "API Key 无效或已过期（401）\(detail)"
            case 403: return "无权访问该模型或接口（403）\(detail)"
            case 404: return "接口或模型不存在（404），请检查 Base URL 与模型名\(detail)"
            case 408: return "请求超时（408）\(detail)"
            case 413: return "对话太长，超过了请求大小上限（413）\(detail)"
            case 429: return "请求过于频繁或额度不足（429）\(detail)"
            case 529: return "服务端过载（529），请稍后再试\(detail)"
            case 500...599: return "服务端出错（\(status)），请稍后再试\(detail)"
            default: return "请求失败（HTTP \(status)）\(detail)"
            }
        case .api(let type, let message):
            switch type {
            case "overloaded_error": return "服务端过载，请稍后再试：\(message)"
            case "rate_limit_error": return "请求过于频繁或额度不足：\(message)"
            case "authentication_error": return "API Key 无效：\(message)"
            case "invalid_request_error": return "请求无效：\(message)"
            default: return "服务端返回错误：\(message)"
            }
        case .network(let message): return "网络不可用：\(message)"
        case .timeout: return "请求超时，请检查网络或稍后再试"
        case .cancelled: return "已停止"
        case .emptyResponse: return "服务端没有返回内容"
        case .decoding(let message): return "响应解析失败：\(message)"
        }
    }

    /// URLError → 中文分类。
    static func from(_ error: Error) -> LLMError {
        if let error = error as? LLMError { return error }
        if error is CancellationError { return .cancelled }
        if let url = error as? URLError {
            switch url.code {
            case .cancelled: return .cancelled
            case .timedOut: return .timeout
            case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed:
                return .network("设备未联网或连接中断")
            case .cannotFindHost, .dnsLookupFailed: return .network("找不到服务器（检查 Base URL）")
            case .cannotConnectToHost: return .network("无法连接到服务器")
            case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate,
                 .serverCertificateNotYetValid, .serverCertificateHasUnknownRoot:
                return .network("TLS 证书校验失败")
            case .appTransportSecurityRequiresSecureConnection: return .network("系统要求 HTTPS 连接")
            default: return .network(url.localizedDescription)
            }
        }
        return .network(error.localizedDescription)
    }

    /// 从错误响应体里取出人能看懂的那句（两种协议都是 `{"error":{"message":…}}`，有的中转是 `{"message":…}`）。
    static func message(fromBody data: Data) -> String {
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let error = object["error"] as? [String: Any], let message = error["message"] as? String { return message }
            if let error = object["error"] as? String { return error }
            if let message = object["message"] as? String { return message }
        }
        let text = String(decoding: data.prefix(300), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return text.hasPrefix("<") ? "" : text // HTML 错误页不往界面上贴
    }
}

private func jsonObject(_ text: String) throws -> [String: Any] {
    guard let object = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else {
        throw LLMError.decoding("不是 JSON 对象")
    }
    return object
}

/// Anthropic Messages 流：message_start / content_block_delta / message_delta / message_stop / ping / error。
struct AnthropicStreamDecoder: Sendable {
    private(set) var finished = false

    mutating func decode(_ event: SSEEvent) throws -> [LLMDelta] {
        let object: [String: Any]
        do { object = try jsonObject(event.data) } catch { throw LLMError.decoding("Anthropic 事件不是 JSON") }
        let type = (object["type"] as? String) ?? event.event ?? ""
        switch type {
        case "message_start":
            guard let message = object["message"] as? [String: Any] else { return [] }
            var deltas: [LLMDelta] = []
            if let model = message["model"] as? String { deltas.append(.model(model)) }
            if let usage = message["usage"] as? [String: Any] {
                let input = (usage["input_tokens"] as? Int ?? 0)
                    + (usage["cache_read_input_tokens"] as? Int ?? 0)
                    + (usage["cache_creation_input_tokens"] as? Int ?? 0)
                deltas.append(.usage(input: input, output: usage["output_tokens"] as? Int))
            }
            return deltas
        case "content_block_delta":
            guard let delta = object["delta"] as? [String: Any] else { return [] }
            switch delta["type"] as? String {
            case "text_delta": return (delta["text"] as? String).map { [.text($0)] } ?? []
            case "thinking_delta": return (delta["thinking"] as? String).map { [.thinking($0)] } ?? []
            default: return [] // signature_delta / input_json_delta：手机 v1 不用工具
            }
        case "message_delta":
            var deltas: [LLMDelta] = []
            if let delta = object["delta"] as? [String: Any], let reason = delta["stop_reason"] as? String {
                deltas.append(.stop(reason))
            }
            if let usage = object["usage"] as? [String: Any] {
                deltas.append(.usage(input: nil, output: usage["output_tokens"] as? Int))
            }
            return deltas
        case "message_stop":
            finished = true
            return []
        case "error":
            let error = object["error"] as? [String: Any]
            throw LLMError.api(type: error?["type"] as? String, message: error?["message"] as? String ?? "未知错误")
        default:
            return [] // ping / content_block_start / content_block_stop
        }
    }
}

/// OpenAI 兼容 Chat Completions 流：`data: {choices:[{delta:{content}}]}` … `data: [DONE]`。
struct OpenAIStreamDecoder: Sendable {
    private(set) var finished = false
    private var reportedModel = false

    mutating func decode(_ event: SSEEvent) throws -> [LLMDelta] {
        let data = event.data.trimmingCharacters(in: .whitespaces)
        if data == "[DONE]" {
            finished = true
            return []
        }
        let object: [String: Any]
        do { object = try jsonObject(data) } catch { throw LLMError.decoding("OpenAI 事件不是 JSON") }
        if let error = object["error"] {
            let body = error as? [String: Any]
            let message = body?["message"] as? String ?? (error as? String) ?? "未知错误"
            let type = body?["type"] as? String ?? (body?["code"]).map { "\($0)" }
            throw LLMError.api(type: type, message: message)
        }
        var deltas: [LLMDelta] = []
        if !reportedModel, let model = object["model"] as? String, !model.isEmpty {
            reportedModel = true
            deltas.append(.model(model))
        }
        if let choices = object["choices"] as? [[String: Any]], let choice = choices.first {
            if let delta = choice["delta"] as? [String: Any] {
                // DeepSeek / 部分中转把思考放在 reasoning_content；OpenRouter 用 reasoning。
                if let thinking = (delta["reasoning_content"] ?? delta["reasoning"]) as? String, !thinking.isEmpty {
                    deltas.append(.thinking(thinking))
                }
                if let text = delta["content"] as? String, !text.isEmpty { deltas.append(.text(text)) }
            }
            if let reason = choice["finish_reason"] as? String { deltas.append(.stop(reason)) }
        }
        if let usage = object["usage"] as? [String: Any] {
            deltas.append(.usage(input: usage["prompt_tokens"] as? Int, output: usage["completion_tokens"] as? Int))
        }
        return deltas
    }
}
