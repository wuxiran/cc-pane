import Foundation

/// `POST /api/providers/export` 的响应（docs/112 §6）。**含明文密钥**：只在内存里经过一次就写进 Keychain，
/// 不落盘、不打日志（`description` 已脱敏）。
struct ProviderExportPayload: Decodable, Sendable, CustomStringConvertible {
    struct Model: Decodable, Sendable, Equatable {
        var id: String
        var label: String?
    }

    struct Provider: Decodable, Sendable, CustomStringConvertible {
        var id: String
        var name: String
        var providerType: String?
        /// `anthropic` | `openai_chat`
        var protocolKind: String
        var baseUrl: String
        var models: [Model]
        var defaultModelId: String?
        var apiKey: String

        enum CodingKeys: String, CodingKey {
            case id, name, providerType, baseUrl, models, defaultModelId, apiKey
            case protocolKind = "protocol"
        }

        var description: String { "Provider(\(name), \(protocolKind), \(baseUrl), apiKey: <redacted>)" }
    }

    struct Skipped: Decodable, Sendable, Equatable {
        var id: String
        var name: String
        var reason: String
    }

    var version: Int
    var exportedAt: String?
    var providers: [Provider]
    var skipped: [Skipped]

    var description: String { "ProviderExportPayload(\(providers.count) providers, \(skipped.count) skipped)" }

    static func reasonLabel(_ reason: String) -> String {
        switch reason {
        case "NO_API_KEY": "电脑上没有填 API Key"
        case "UNSUPPORTED_TYPE": "该类型不能在手机直连（如 Bedrock / Vertex / 登录态）"
        case "SECRET_UNAVAILABLE": "电脑钥匙串读取失败"
        case "NOT_FOUND": "电脑上已删除"
        default: reason
        }
    }
}

enum ProviderImportError: LocalizedError, Equatable {
    case invalidCode
    case wrongCode(attemptsLeft: Int?)
    case expired
    case locked
    case rateLimited
    case needsPairing
    case readOnly
    case tokenRejected
    case desktopNotRunning
    case unsupported
    case network(String)
    case server(Int, String)

    var errorDescription: String? {
        switch self {
        case .invalidCode: "导出码应为 6 位数字"
        case .wrongCode(let left):
            if let left, left > 0 { "导出码不正确（还可再试 \(left) 次）" } else { "导出码不正确，或电脑上没有进行中的导出" }
        case .expired: "导出码已过期，请在电脑上重新生成"
        case .locked: "错误次数过多，本次导出已作废，请在电脑上重新生成"
        case .rateLimited: "尝试过于频繁，请过几分钟再试"
        case .needsPairing: "需要先用配对码与这台电脑配对（导出只对已配对设备开放）"
        case .readOnly: "这台电脑开启了远程只读，不允许导出"
        case .tokenRejected: "令牌失效，请重新配对这台电脑"
        case .desktopNotRunning: "这台电脑上的 CC-Panes 桌面端没有运行"
        case .unsupported: "电脑端版本过旧，不支持导出供应商"
        case .network(let message): "无法连接电脑：\(message)"
        case .server(let status, let message): message.isEmpty ? "导入失败（HTTP \(status)）" : "导入失败：\(message)"
        }
    }
}

/// 一台可导入的电脑：必须是**已配对**（有设备令牌）的连接。
struct ProviderImportTarget: Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var baseURL: URL
    var token: String

    /// 从一条 APIClient 构造；没有设备令牌（Cookie / 免登录直连）返回 nil。
    init?(id: String, name: String, api: APIClient) {
        guard let token = api.token, !token.isEmpty else { return nil }
        self.init(id: id, name: name, baseURL: api.baseURL, token: token)
    }

    init(id: String, name: String, baseURL: URL, token: String) {
        self.id = id
        self.name = name
        self.baseURL = baseURL
        self.token = token
    }
}

/// 导入请求：请求构建与响应映射是纯函数，便于单测。
enum ProviderExportClient {
    static func request(target: ProviderImportTarget, code: String) throws -> URLRequest {
        guard let code = DevicePairing.normalizeCode(code) else { throw ProviderImportError.invalidCode }
        var request = URLRequest(url: target.baseURL.appending(path: "/api/providers/export"))
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(target.token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(["code": code])
        return request
    }

    static func parse(status: Int, data: Data) throws -> ProviderExportPayload {
        let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let code = body?["code"] as? String ?? ""
        let message = body?["message"] as? String ?? ""
        switch status {
        case 200..<300:
            do { return try JSONDecoder().decode(ProviderExportPayload.self, from: data) } catch {
                throw ProviderImportError.server(status, "响应格式不对")
            }
        case 400: throw code == "EXPORT_CODE_INVALID"
            ? ProviderImportError.wrongCode(attemptsLeft: body?["attemptsLeft"] as? Int)
            : ProviderImportError.server(status, message)
        case 401: throw ProviderImportError.tokenRejected
        case 403:
            switch code {
            case "READ_ONLY": throw ProviderImportError.readOnly
            default: throw ProviderImportError.needsPairing
            }
        case 404, 405: throw ProviderImportError.unsupported
        case 410: throw ProviderImportError.expired
        case 429: throw code == "EXPORT_CODE_LOCKED" ? ProviderImportError.locked : ProviderImportError.rateLimited
        case 503: throw ProviderImportError.desktopNotRunning
        default: throw ProviderImportError.server(status, message)
        }
    }

    static func redeem(target: ProviderImportTarget, code: String,
                       session: URLSession? = nil) async throws -> ProviderExportPayload {
        let request = try request(target: target, code: code)
        let urlSession: URLSession
        if let session {
            urlSession = session
        } else {
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = 20
            config.urlCache = nil
            DirectRoute.configure(config, for: target.baseURL)
            urlSession = URLSession(configuration: config)
        }
        defer { if session == nil { urlSession.finishTasksAndInvalidate() } }
        let (data, response): (Data, URLResponse)
        do { (data, response) = try await urlSession.data(for: request) } catch {
            throw ProviderImportError.network(error.localizedDescription)
        }
        return try parse(status: (response as? HTTPURLResponse)?.statusCode ?? 0, data: data)
    }
}
