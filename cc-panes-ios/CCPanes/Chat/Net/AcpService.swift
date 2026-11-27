import Foundation

/// 「对话」后端抽象：真实实现走 cc-panes-web 的 `/api/acp/*` + `/ws/acp/{chatId}`
/// （AcpClient），调试用进程内 mock（MockAcpService，`-acpMock YES`）。
protocol AcpService: Sendable {
    func engines() async throws -> [AcpEngineInfo]
    func chats() async throws -> [AcpChatSummary]
    func history() async throws -> [AcpHistoryEntry]
    func create(engineId: String, cwd: String, resumeAcpSessionId: String?) async throws -> AcpChatSnapshot
    /// 当前快照 + lastSeq（契约：`{snapshot,lastSeq}` 嵌套形状；不改动正文，仅用于头部信息）。
    func detail(chatId: String) async throws -> (AcpChatSnapshot, Int?)
    /// promptId：客户端生成，服务端写进 `user_prompt` 事件，用来按 id 抵消本地回显。
    func prompt(chatId: String, text: String, promptId: String) async throws
    func cancel(chatId: String) async throws
    func setMode(chatId: String, modeId: String) async throws
    func setModel(chatId: String, modelId: String) async throws
    /// ACP Session Config Options（`POST …/config {configId,value}`）。
    func setConfigOption(chatId: String, configId: String, value: String) async throws
    func respondPermission(chatId: String, requestKey: String, optionId: String?) async throws
    func respondElicitation(chatId: String, requestKey: String, response: JSONValue) async throws
    func stop(chatId: String) async throws
    /// 打开事件流（afterSeq 续传）。流结束 = 连接关闭，最后一帧为 `.closed`。
    func openStream(chatId: String, afterSeq: Int) async -> AsyncStream<AcpFrame>
}

/// ACP 相关错误：503 电脑端未运行、403 只读，其余沿用 APIError。
enum AcpError: LocalizedError, Sendable, Equatable {
    case hostUnavailable
    case readOnly(String)
    case other(String)

    var errorDescription: String? {
        switch self {
        case .hostUnavailable: "电脑端 CC-Panes 未运行"
        case .readOnly(let m): m.isEmpty ? "远程只读模式，无法操作对话" : m
        case .other(let m): m
        }
    }

    /// 由 HTTP 状态 + 错误体映射。错误体按 `{code,message}` 或 `{error}` 宽松解析。
    static func from(status: Int, body: Data) -> AcpError {
        let obj = try? JSONDecoder().decode(JSONValue.self, from: body)
        let code = obj?["code"]?.string ?? obj?["error"]?.string
        let message = obj?["message"]?.string ?? ""
        if status == 503 || code == "ACP_HOST_UNAVAILABLE" { return .hostUnavailable }
        if status == 403 || code == "READ_ONLY" { return .readOnly(message) }
        if !message.isEmpty { return .other(message) }
        return .other("HTTP \(status)")
    }
}

/// 调试开关：`-acpMock YES` 启用进程内 mock。
enum AcpEnvironment {
    @MainActor
    static func service(api: APIClient, defaults: UserDefaults = .standard) -> any AcpService {
        if defaults.bool(forKey: "acpMock") { return MockAcpService.shared }
        return AcpClient(api: api)
    }
}
