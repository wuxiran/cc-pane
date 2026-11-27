import Foundation

/// 地址簿里的一台电脑。只存非机密元数据；令牌在 Keychain（account = `tokenAccount`）。
struct Computer: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    /// 规范化后的 http(s) 根地址；同一台电脑可有局域网 IP、Tailscale 100.x 等多条。
    var addresses: [String]
    /// 配对后为 Keychain account（= id）；nil = 未配对（Cookie / 免登录直连）。
    var tokenAccount: String?
    var lastSeen: Date?
    /// 最近一次连通所用地址（展示用，择优时不作硬依赖）。
    var lastAddress: String?

    var isPaired: Bool { tokenAccount != nil }

    init(id: String = UUID().uuidString, name: String, addresses: [String],
         tokenAccount: String? = nil, lastSeen: Date? = nil, lastAddress: String? = nil) {
        self.id = id
        self.name = name
        self.addresses = addresses
        self.tokenAccount = tokenAccount
        self.lastSeen = lastSeen
        self.lastAddress = lastAddress
    }
}

/// 地址簿持久化：JSON 存 UserDefaults；首次读取时把旧版单地址 `ccpanes.serverURL` 迁成一条。
struct ComputerBookStore: Sendable {
    nonisolated(unsafe) let defaults: UserDefaults

    static let listKey = "ccpanes.computers.v1"
    static let currentKey = "ccpanes.currentComputerId"
    static let legacyServerKey = "ccpanes.serverURL"

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    struct Loaded: Equatable {
        var computers: [Computer]
        var currentId: String?
    }

    func load() -> Loaded {
        if let data = defaults.data(forKey: Self.listKey),
           let computers = try? JSONDecoder().decode([Computer].self, from: data) {
            let current = defaults.string(forKey: Self.currentKey)
            return Loaded(computers: computers,
                          currentId: computers.contains { $0.id == current } ? current : computers.first?.id)
        }
        return migrateLegacy()
    }

    func save(_ computers: [Computer], currentId: String?) {
        if let data = try? JSONEncoder().encode(computers) { defaults.set(data, forKey: Self.listKey) }
        defaults.set(currentId, forKey: Self.currentKey)
    }

    private func migrateLegacy() -> Loaded {
        guard let raw = defaults.string(forKey: Self.legacyServerKey),
              let url = AddressBook.normalize(raw) else { return Loaded(computers: []) }
        let computer = Computer(name: url.host() ?? "我的电脑", addresses: [url.absoluteString])
        save([computer], currentId: computer.id)
        return Loaded(computers: [computer], currentId: computer.id)
    }
}

/// 地址工具：规范化 + 分类（局域网优先、Tailscale 兜底）。
enum AddressBook {
    enum Kind: Int, Comparable, Sendable {
        case lan = 0, tailscale = 1, other = 2
        static func < (a: Kind, b: Kind) -> Bool { a.rawValue < b.rawValue }

        var label: String {
            switch self {
            case .lan: "局域网"
            case .tailscale: "Tailscale"
            case .other: "其他"
            }
        }
    }

    static func normalize(_ raw: String) -> URL? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while text.hasSuffix("/") { text.removeLast() }
        if !text.contains("://") { text = "http://" + text }
        guard let url = URL(string: text), let scheme = url.scheme,
              ["http", "https"].contains(scheme), url.host() != nil else { return nil }
        return url
    }

    static func kind(of url: URL) -> Kind {
        guard let host = url.host()?.lowercased() else { return .other }
        if host.hasSuffix(".ts.net") { return .tailscale }
        if host == "localhost" || host.hasSuffix(".local") || host == "::1" { return .lan }
        let parts = host.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4 else { return .other }
        switch (parts[0], parts[1]) {
        case (127, _), (10, _), (192, 168), (169, 254), (172, 16...31): return .lan
        case (100, 64...127): return .tailscale
        default: return .other
        }
    }

    static func kind(of raw: String) -> Kind {
        normalize(raw).map { kind(of: $0) } ?? .other
    }

    /// 展示 / 探测顺序：局域网 → Tailscale → 其他；同类保持录入顺序。
    static func ordered(_ addresses: [String]) -> [String] {
        addresses.enumerated()
            .sorted { (kind(of: $0.element), $0.offset) < (kind(of: $1.element), $1.offset) }
            .map(\.element)
    }
}
