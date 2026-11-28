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
    /// 服务端自报的机器名 / 实例 id / 是否开发版（`/api/device/info`；旧版本无 instanceId）。
    var hostname: String?
    var instanceId: String?
    var isDevInstance: Bool?
    /// 「保持连接」：nil 视为开（旧数据迁移后全部保持连接）。
    var keepConnected: Bool?

    var isPaired: Bool { tokenAccount != nil }
    var isEnabled: Bool { keepConnected ?? true }

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

/// 电脑显示名：用户改过的名字优先，否则服务端机器名，再否则 `host:port`；
/// 重名时追加「开发版」或端口区分（同一台 Mac 上 release 18080 与 dev 18081 都叫 wuxirandeMBP）。
enum ComputerNaming {
    static func hostPort(_ address: String?) -> String? {
        guard let address, let url = AddressBook.normalize(address), let host = url.host() else { return nil }
        return url.port.map { "\(host):\($0)" } ?? host
    }

    /// 名字是不是「用地址/机器名充当的默认值」（不是用户起的）。
    static func isAutoName(_ c: Computer) -> Bool {
        let name = c.name.trimmingCharacters(in: .whitespaces)
        if name.isEmpty || name == "电脑" || name == "我的电脑" || name == c.hostname { return true }
        return c.addresses.contains { address in
            AddressBook.normalize(address).map { name == $0.host() || name == hostPort(address) } ?? false
        }
    }

    static func baseName(_ c: Computer) -> String {
        if !isAutoName(c) { return c.name }
        if let host = c.hostname, !host.isEmpty { return host }
        return hostPort(primaryAddress(c)) ?? c.name
    }

    static func primaryAddress(_ c: Computer) -> String? {
        c.lastAddress ?? AddressBook.ordered(c.addresses).first
    }

    /// id → 唯一显示名。
    static func displayNames(_ computers: [Computer]) -> [String: String] {
        var names = Dictionary(uniqueKeysWithValues: computers.map { ($0.id, baseName($0)) })
        func collisions() -> [String: [Computer]] {
            Dictionary(grouping: computers, by: { names[$0.id] ?? "" }).filter { $0.value.count > 1 }
        }
        // 第一轮：开发版标记
        for (_, group) in collisions() {
            for c in group where c.isDevInstance == true { names[c.id] = (names[c.id] ?? "") + " · 开发版" }
        }
        // 第二轮：仍重名的追加端口（无端口用完整 host:port）
        for (_, group) in collisions() {
            for c in group {
                let address = primaryAddress(c).flatMap(AddressBook.normalize)
                let suffix = address?.port.map { ":\($0)" } ?? hostPort(primaryAddress(c)) ?? String(c.id.prefix(4))
                names[c.id] = (names[c.id] ?? "") + " " + suffix
            }
        }
        return names
    }

    /// 服务端返回 `defaultCwd` 落在 `.cc-panes-dev` 下 = 开发版实例。
    static func isDev(_ info: DeviceInfo) -> Bool {
        info.defaultCwd?.contains(".cc-panes-dev") ?? false
    }
}

/// 按 instanceId 去重：同一个 CC-Panes 实例被以不同地址（局域网 / Tailscale）存了两条时合并为一条。
enum ComputerDedupe {
    struct Result: Equatable {
        var computers: [Computer]
        /// 被并入别的条目而删掉的 id（其令牌若已无人引用，由调用方清理）。
        var removed: [String]
    }

    static func merge(_ computers: [Computer]) -> Result {
        var out: [Computer] = []
        var removed: [String] = []
        var indexByInstance: [String: Int] = [:]
        for c in computers {
            guard let instance = c.instanceId, !instance.isEmpty else { out.append(c); continue }
            guard let i = indexByInstance[instance] else {
                indexByInstance[instance] = out.count
                out.append(c)
                continue
            }
            var keep = out[i]
            for address in c.addresses where !keep.addresses.contains(address) { keep.addresses.append(address) }
            // 保留带令牌的那条身份（令牌 account 不随 id 变）
            if keep.tokenAccount == nil { keep.tokenAccount = c.tokenAccount }
            if ComputerNaming.isAutoName(keep), !ComputerNaming.isAutoName(c) { keep.name = c.name }
            keep.lastSeen = [keep.lastSeen, c.lastSeen].compactMap { $0 }.max()
            if c.keepConnected == true { keep.keepConnected = true }
            out[i] = keep
            removed.append(c.id)
        }
        return Result(computers: out, removed: removed)
    }
}
