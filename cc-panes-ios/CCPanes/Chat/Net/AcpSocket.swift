import Foundation
import os

private let log = Logger(subsystem: "com.ccpanes.ios", category: "acp-socket")

/// `/ws/acp/{chatId}?afterSeq=N`：只读下行（event / reset / synchronized）。
/// 私网地址经 DirectRoute 绕过系统代理（否则 WS 升级被代理断开）。
final class AcpSocket: @unchecked Sendable {
    private let task: URLSessionWebSocketTask
    private let session: URLSession

    init(request: URLRequest) {
        let config = URLSessionConfiguration.default
        config.httpShouldSetCookies = false // Cookie 头已手动带上
        if let url = request.url { DirectRoute.configure(config, for: url) }
        session = URLSession(configuration: config)
        task = session.webSocketTask(with: request)
        task.maximumMessageSize = 16 * 1024 * 1024
    }

    func open() -> AsyncStream<AcpFrame> {
        task.resume()
        let task = self.task
        let session = self.session
        return AsyncStream { continuation in
            let receiver = Task {
                while !Task.isCancelled {
                    do {
                        let message = try await task.receive()
                        if let frame = Self.parse(message) { continuation.yield(frame) }
                    } catch {
                        let status = (task.response as? HTTPURLResponse)?.statusCode
                        log.info("acp ws closed status=\(status ?? -1, privacy: .public) \(String(describing: error), privacy: .public)")
                        continuation.yield(.closed(status: status))
                        break
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in
                receiver.cancel()
                task.cancel(with: .goingAway, reason: nil)
                session.finishTasksAndInvalidate()
            }
        }
    }

    static func parse(_ message: URLSessionWebSocketTask.Message) -> AcpFrame? {
        switch message {
        case .string(let text): AcpFrame.parse(Data(text.utf8))
        case .data(let data): AcpFrame.parse(data)
        @unknown default: nil
        }
    }
}
