import Foundation

/// 本机 / 局域网地址一律直连，不走系统代理。
///
/// 实测（模拟器继承 Mac 的 HTTP 代理）：REST 经代理能通，WebSocket 升级却在代理处
/// 被断开（POSIX 57 Socket is not connected）。连电脑本就该直连；公网/Tailscale
/// HTTPS 地址仍尊重系统代理。
enum DirectRoute {
    static func isLocal(_ url: URL) -> Bool {
        guard let host = url.host()?.lowercased() else { return false }
        if host == "localhost" || host.hasSuffix(".local") || host == "::1" { return true }
        let parts = host.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4 else { return false }
        switch (parts[0], parts[1]) {
        case (127, _), (10, _), (192, 168), (169, 254): return true
        case (172, 16...31): return true
        case (100, 64...127): return true // CGNAT / Tailscale 100.x
        default: return false
        }
    }

    static func configure(_ config: URLSessionConfiguration, for url: URL) {
        if isLocal(url) {
            config.connectionProxyDictionary = [
                "HTTPEnable": false, "HTTPSEnable": false, "SOCKSEnable": false,
            ]
        }
    }
}
