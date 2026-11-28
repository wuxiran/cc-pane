import Foundation

/// 多地址择优（t3code 做法）：所有地址并发探 `/api/health`，局域网地址先跑 ~500ms，
/// 其余地址在领跑窗口结束或局域网全部失败后才开探；第一个成功者胜出，其余取消。
enum AddressProbe {
    typealias Probe = @Sendable (URL) async -> Bool

    /// 返回胜出地址；全部不通返回 nil。
    static func pickBest(_ addresses: [String], headStart: Duration = .milliseconds(500),
                         probe: @escaping Probe = healthProbe) async -> URL? {
        let urls = AddressBook.ordered(addresses).compactMap(AddressBook.normalize)
        guard !urls.isEmpty else { return nil }
        let preferred = urls.filter { AddressBook.kind(of: $0) == .lan }
        let fallback = urls.filter { AddressBook.kind(of: $0) != .lan }
        let gate = FallbackGate(preferredCount: preferred.count)

        return await withTaskGroup(of: URL?.self) { group in
            for url in preferred {
                group.addTask {
                    let ok = await probe(url)
                    if !ok { await gate.preferredFailed() }
                    return ok ? url : nil
                }
            }
            for url in fallback {
                group.addTask {
                    await gate.wait(headStart)
                    guard !Task.isCancelled else { return nil }
                    return await probe(url) ? url : nil
                }
            }
            for await result in group {
                if let result {
                    group.cancelAll()
                    return result
                }
            }
            return nil
        }
    }

    /// 探测全部地址（在线状态点用）：返回每条地址是否可达。
    static func probeAll(_ addresses: [String], probe: @escaping Probe = healthProbe) async -> [String: Bool] {
        await withTaskGroup(of: (String, Bool).self) { group in
            for raw in addresses {
                group.addTask {
                    guard let url = AddressBook.normalize(raw) else { return (raw, false) }
                    return (raw, await probe(url))
                }
            }
            var out: [String: Bool] = [:]
            for await (raw, ok) in group { out[raw] = ok }
            return out
        }
    }

    /// 免鉴权的存活探针：`GET /api/health` → `{"ok":true}`。
    @Sendable static func healthProbe(_ url: URL) async -> Bool {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 3
        config.waitsForConnectivity = false
        DirectRoute.configure(config, for: url)
        let session = URLSession(configuration: config)
        defer { session.finishTasksAndInvalidate() }
        var request = URLRequest(url: url.appending(path: "/api/health"))
        request.timeoutInterval = 3
        guard let (data, response) = try? await session.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return false }
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        return obj?["ok"] as? Bool ?? true
    }
}

/// 兜底地址的放行闸：领跑时间到，或局域网地址全部失败，先到者为准。
/// 20ms 轮询足够（探测本身是百毫秒级），避免续体在 actor 间穿梭。
private actor FallbackGate {
    private let preferredCount: Int
    private var failures = 0

    init(preferredCount: Int) { self.preferredCount = preferredCount }

    private var allPreferredFailed: Bool { failures >= preferredCount }

    func preferredFailed() { failures += 1 }

    func wait(_ headStart: Duration) async {
        let deadline = ContinuousClock.now + headStart
        while !allPreferredFailed, ContinuousClock.now < deadline, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(20))
        }
    }
}
