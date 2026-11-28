import Foundation

/// `POST /api/device/pair` 成功响应（cc-panes-web routes/device.rs）。
struct PairResult: Decodable, Sendable, Equatable {
    var token: String
    var hostname: String?
    var appVersion: String?
}

/// `GET /api/device/info`（需鉴权）。
struct DeviceInfo: Decodable, Sendable, Equatable {
    var hostname: String?
    var os: String?
    var osVersion: String?
    var arch: String?
    var appVersion: String?
    var uptimeSecs: Int?
    var defaultCwd: String?
    var headless: Bool?
    var instanceId: String?
}

enum PairingError: LocalizedError, Equatable {
    case invalidAddress
    case invalidCode
    case rejected
    case notAccepting
    case remoteForbidden(String)
    case unavailable
    case network(String)
    case server(Int, String)

    var errorDescription: String? {
        switch self {
        case .invalidAddress: "电脑地址无效"
        case .invalidCode: "配对码应为 6 位数字"
        case .rejected: "配对码错误或已过期，请在电脑端重新生成"
        case .notAccepting: "该电脑未开启「允许其他设备连接」（设置 → Web 访问 → 其他设备）"
        case .remoteForbidden: "电脑端 Web 访问设置不允许此设备（检查局域网开关 / IP 白名单）"
        case .unavailable: "电脑端设备令牌服务不可用"
        case .network(let m): "无法连接电脑：\(m)"
        case .server(let code, let m): m.isEmpty ? "配对失败（HTTP \(code)）" : "配对失败：\(m)"
        }
    }
}

/// 配对码换设备令牌。请求构建与响应映射是纯函数，便于单测。
enum DevicePairing {
    /// 去掉空格 / 连字符；必须恰好 6 位数字（服务端 `{:06}` 生成）。
    static func normalizeCode(_ raw: String) -> String? {
        let digits = raw.filter { !$0.isWhitespace && $0 != "-" }
        guard digits.count == 6, digits.allSatisfy(\.isASCII), digits.allSatisfy(\.isNumber) else { return nil }
        return digits
    }

    static func pairRequest(baseURL: URL, code: String, deviceName: String) throws -> URLRequest {
        guard let code = normalizeCode(code) else { throw PairingError.invalidCode }
        var request = URLRequest(url: baseURL.appending(path: "/api/device/pair"))
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let name = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
        request.httpBody = try JSONEncoder().encode(["code": code, "name": name.isEmpty ? "iPhone" : name])
        return request
    }

    /// HTTP 状态 + 响应体 → 结果。服务端错误体是纯文本（非 JSON）。
    static func parse(status: Int, data: Data) throws -> PairResult {
        let text = String(data: data, encoding: .utf8) ?? ""
        switch status {
        case 200..<300:
            guard let result = try? JSONDecoder().decode(PairResult.self, from: data),
                  !result.token.isEmpty else { throw PairingError.server(status, "响应缺少令牌") }
            return result
        case 401: throw PairingError.rejected
        case 403:
            throw text.contains("does not accept") ? PairingError.notAccepting : PairingError.remoteForbidden(text)
        case 503: throw PairingError.unavailable
        default: throw PairingError.server(status, text)
        }
    }

    static func pair(baseURL: URL, code: String, deviceName: String) async throws -> PairResult {
        let request = try pairRequest(baseURL: baseURL, code: code, deviceName: deviceName)
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15
        DirectRoute.configure(config, for: baseURL)
        let session = URLSession(configuration: config)
        defer { session.finishTasksAndInvalidate() }
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw PairingError.network(error.localizedDescription)
        }
        return try parse(status: (response as? HTTPURLResponse)?.statusCode ?? 0, data: data)
    }
}
