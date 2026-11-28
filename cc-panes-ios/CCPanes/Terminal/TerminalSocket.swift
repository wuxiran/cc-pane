import Foundation
import os

private let log = Logger(subsystem: "com.ccpanes.ios", category: "terminal-socket")

/// 服务端 → 客户端的终端帧（/ws/{sessionId} 文本 JSON）。
enum TerminalEvent: Sendable, Equatable {
    case output(String, endSeq: UInt64?)
    case exit(Int?)
    case desync
    case closed
}

/// /ws/{sessionId}：下行 output/exit/desync，上行 input/resize。
/// 用 URLSessionWebSocketTask（原生 permessage-deflate、大帧，t3code 同款理由）。
final class TerminalSocket: @unchecked Sendable {
    private let task: URLSessionWebSocketTask
    private let session: URLSession

    init(request: URLRequest) {
        let config = URLSessionConfiguration.default
        config.httpShouldSetCookies = false // Cookie 头已手动带上
        if let url = request.url { DirectRoute.configure(config, for: url) }
        session = URLSession(configuration: config, delegate: SocketLogDelegate(), delegateQueue: nil)
        task = session.webSocketTask(with: request)
        task.maximumMessageSize = 64 * 1024 * 1024
    }

    /// 打开连接并返回事件流；流结束即连接关闭。
    func open() -> AsyncStream<TerminalEvent> {
        task.resume()
        let task = self.task
        return AsyncStream { continuation in
            let receiver = Task {
                while !Task.isCancelled {
                    do {
                        let message = try await task.receive()
                        log.debug("ws message")
                        if let event = Self.parse(message) { continuation.yield(event) }
                    } catch {
                        log.error("ws receive failed: \(String(describing: error), privacy: .public)")
                        continuation.yield(.closed)
                        break
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in receiver.cancel() }
        }
    }

    func sendInput(_ data: String) { send(["type": "input", "data": data]) }

    func sendResize(cols: Int, rows: Int) { send(["type": "resize", "cols": cols, "rows": rows]) }

    func close() {
        task.cancel(with: .goingAway, reason: nil)
        session.finishTasksAndInvalidate()
    }

    private func send(_ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { _ in }
    }

    static func parse(_ message: URLSessionWebSocketTask.Message) -> TerminalEvent? {
        let data: Data
        switch message {
        case .string(let text): data = Data(text.utf8)
        case .data(let d): data = d
        @unknown default: return nil
        }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String else { return nil }
        switch type {
        case "output":
            let seq = (obj["endSeq"] as? NSNumber)?.uint64Value
            return .output(obj["data"] as? String ?? "", endSeq: seq)
        case "exit":
            return .exit((obj["exitCode"] as? NSNumber)?.intValue)
        case "killed", "sessionKilled":
            return .exit(nil)
        case "desync":
            return .desync
        default:
            return nil
        }
    }
}

private final class SocketLogDelegate: NSObject, URLSessionWebSocketDelegate {
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        log.info("ws opened")
    }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        log.info("ws closed code=\(closeCode.rawValue, privacy: .public)")
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        log.info("ws task complete error=\(String(describing: error), privacy: .public) status=\((task.response as? HTTPURLResponse)?.statusCode ?? -1, privacy: .public)")
    }
}
