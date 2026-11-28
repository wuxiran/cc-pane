import Foundation

// 通讯录（docs/112 §5）的纯数据层：Bot 条目解码（宽松、字段别名集中在这里）、远程权限策略、
// 在线态推导、按电脑分组排序。网络只在 ContactsService 里，界面只读这里的结果。

// MARK: - 远程权限策略（§5.3）

enum RemotePolicy: Sendable, Hashable {
    case deny, askOrigin, allowlist, full
    case unknown(String)

    /// 契约默认 `ask_origin`；字段缺失按默认理解。
    static let `default` = RemotePolicy.askOrigin
    /// 可选级别（由低到高）。
    static let levels: [RemotePolicy] = [.deny, .askOrigin, .allowlist, .full]

    init(raw: String?) {
        guard let raw, !raw.isEmpty else { self = .default; return }
        switch raw.lowercased().replacingOccurrences(of: "-", with: "_") {
        case "deny", "denied", "off": self = .deny
        case "ask_origin", "askorigin", "ask": self = .askOrigin
        case "allowlist", "allow_list": self = .allowlist
        case "full", "full_access": self = .full
        default: self = .unknown(raw)
        }
    }

    /// 上行写回的线上值。
    var raw: String {
        switch self {
        case .deny: "deny"
        case .askOrigin: "ask_origin"
        case .allowlist: "allowlist"
        case .full: "full"
        case .unknown(let raw): raw
        }
    }

    var label: String {
        switch self {
        case .deny: "工具全拒"
        case .askOrigin: "逐条审批"
        case .allowlist: "白名单放行"
        case .full: "完全信任"
        case .unknown(let raw): "未知（\(raw)）"
        }
    }

    var detail: String {
        switch self {
        case .deny: "可以聊天；远程回合里的工具调用一律自动拒绝，提问自动谢绝。"
        case .askOrigin: "所有工具审批留给发起方（手机 / 发起设备）弹卡处理，电脑端主人也可代批。"
        case .allowlist: "勾选的工具类型自动放行，其余仍回传发起方审批。"
        case .full: "远程触发的回合全部自动放行，等于把这台电脑的执行权交给已配对设备（只对设备令牌生效）。每条工具调用仍记入日志可审计。"
        case .unknown: "电脑端返回了本版本不认识的策略，按最严格理解。"
        }
    }

    var symbol: String {
        switch self {
        case .deny: "hand.raised.slash.fill"
        case .askOrigin: "person.badge.shield.checkmark.fill"
        case .allowlist: "checklist"
        case .full: "exclamationmark.shield.fill"
        case .unknown: "questionmark.diamond.fill"
        }
    }

    /// 需要红色警示（开启时二次确认 + 常驻徽标）。
    var isDangerous: Bool { self == .full }

    /// `allowlist` 可勾选的 ACP ToolKind（与桌面 RemotePolicyDialog 同表；不接受 `*`）。
    static let allowKinds: [(id: String, label: String)] = [
        ("read", "读取"), ("search", "搜索"), ("fetch", "联网"), ("edit", "编辑"), ("execute", "执行命令"), ("other", "其他"),
    ]

    static func kindLabel(_ id: String) -> String { allowKinds.first { $0.id == id }?.label ?? id }
}

/// `PATCH /api/bots/{id}` 的一次修改（§5.2）：改成 `full` 必须带 `confirmFull:true`。
struct BotRemoteChange: Sendable, Equatable {
    var policy: RemotePolicy?
    var allowKinds: [String]?
    var confirmFull = false

    var body: JSONValue {
        var object: [String: JSONValue] = [:]
        if let policy { object["remotePolicy"] = .string(policy.raw) }
        if let allowKinds { object["remoteAllowKinds"] = .array(allowKinds.map(JSONValue.string)) }
        if confirmFull { object["confirmFull"] = .bool(true) }
        return .object(object)
    }
}

// MARK: - Bot 条目

/// `GET /api/bots` 的一项（§5.2：`{id,name,avatar,engineId,personaSummary,status,remotePolicy}`），
/// 加上从同一台电脑 `/api/acp/chats` 合并来的对话态（待审批 / lastSeq）。
struct BotContact: Identifiable, Sendable, Hashable {
    /// 所在电脑（ContactNode.id）。
    var nodeId: String
    var botId: String
    var name: String
    /// 单个 emoji；空 = 用名字首字。
    var avatar: String?
    /// 头像底色（CSS 颜色，如 `#7c3aed`）。
    var color: String?
    var engineId: String
    var personaSummary: String?
    var status: String?
    var remotePolicy: RemotePolicy
    /// `allowlist` 档自动放行的 ToolKind。
    var remoteAllowKinds: [String] = []
    /// 是否对其他设备共享；`/api/bots` 只列共享的，这里恒为 true（保留以防后端改口径）。
    var remoteShared = true
    var cwd: String?
    var chatId: String
    // 来自 /api/acp/chats（对话没在跑时为 nil / 0）
    var pendingPermissions: Int = 0
    var lastSeq: Int?
    var updatedAt: Int64?

    var id: String { "\(nodeId)/\(botId)" }

    /// 宽松解码：只有 `id` 必需；字段别名集中在这里（后端改名 = 只改这一处）。
    static func parse(_ value: JSONValue, nodeId: String) -> BotContact? {
        func str(_ keys: String...) -> String? {
            for key in keys {
                if let s = value[key]?.string, !s.trimmingCharacters(in: .whitespaces).isEmpty { return s }
            }
            return nil
        }
        guard let botId = str("id", "botId") else { return nil }
        let persona = str("personaSummary", "summary", "persona").map(Self.summarize)
        return BotContact(
            nodeId: nodeId,
            botId: botId,
            name: str("name", "displayName") ?? botId,
            avatar: str("avatar", "emoji"),
            color: str("color"),
            engineId: str("engineId", "engine") ?? "claude",
            personaSummary: persona,
            status: str("status", "phase"),
            remotePolicy: RemotePolicy(raw: str("remotePolicy", "policy")),
            remoteAllowKinds: (value["remoteAllowKinds"]?.array ?? []).compactMap(\.string),
            remoteShared: value["remoteShared"]?.bool ?? true,
            cwd: str("cwd", "effectiveCwd"),
            chatId: str("chatId") ?? "bot-\(botId)",
            pendingPermissions: value["pendingPermissions"]?.int ?? 0,
            lastSeq: value["lastSeq"]?.int,
            updatedAt: value["updatedAt"]?.number.map { Int64($0) })
    }

    /// 列表响应：裸数组或 `{bots:[…]}` / `{items:[…]}`。
    static func parseList(_ value: JSONValue, nodeId: String) -> [BotContact] {
        let items = value.array ?? value["bots"]?.array ?? value["items"]?.array ?? []
        return items.compactMap { parse($0, nodeId: nodeId) }
    }

    /// 人设摘要只取一行（服务端给全文时兜底截断）。
    static func summarize(_ text: String) -> String {
        let line = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return trimmed.count > 80 ? String(trimmed.prefix(80)) + "…" : trimmed
    }

    /// 合并同一台电脑上的对话摘要（`bot-{id}` 那条 ACP chat）。
    mutating func merge(chat: AcpChatSummary) {
        pendingPermissions = max(pendingPermissions, chat.pendingPermissions ?? 0)
        lastSeq = chat.lastSeq ?? lastSeq
        updatedAt = chat.updatedAt ?? updatedAt
        if status == nil { status = chat.status }
    }

    /// 头像文字：emoji 优先，否则名字首字。
    var avatarText: String {
        if let avatar, !avatar.isEmpty { return avatar }
        return name.first.map { String($0).uppercased() } ?? "?"
    }

    var avatarIsEmoji: Bool { avatar.map { !$0.isEmpty } ?? false }
}

// MARK: - 在线态

/// Bot 在通讯录里的状态：先看电脑在不在线，再看审批，再看 Bot 进程相位。
enum BotPresence: Sendable, Equatable {
    case waiting      // 有待审批
    case busy         // 生成中 / 启动中
    case online       // 已启动、空闲
    case dormant      // 未启动（发消息会自动拉起）
    case ended(failed: Bool) // 进程已退出 / 失败（发消息同样会重新拉起）
    case unreachable  // 所在电脑离线

    init(contact: BotContact, nodeOnline: Bool) {
        guard nodeOnline else { self = .unreachable; return }
        if contact.pendingPermissions > 0 { self = .waiting; return }
        // §5.2 status：idle（未启动）| starting | ready | generating | exited | failed
        switch contact.status?.lowercased() {
        case "generating", "starting": self = .busy
        case "ready": self = .online
        case "exited": self = .ended(failed: false)
        case "failed": self = .ended(failed: true)
        default: self = .dormant
        }
    }

    /// 映射到设计语言的四种相位色（橙 / 蓝 / 绿 / 灰）。
    var phase: SessionPhase {
        switch self {
        case .waiting: .waiting
        case .busy: .running
        case .online: .idle
        case .dormant, .ended, .unreachable: .exited
        }
    }

    var label: String {
        switch self {
        case .waiting: "待审批"
        case .busy: "工作中"
        case .online: "在线"
        case .dormant: "未启动"
        case .ended(let failed): failed ? "失败" : "已退出"
        case .unreachable: "电脑离线"
        }
    }

    var sortRank: Int {
        switch self {
        case .waiting: 0
        case .busy: 1
        case .online: 2
        case .dormant: 3
        case .ended: 4
        case .unreachable: 5
        }
    }
}

// MARK: - 电脑节点

/// 通讯录里的一台电脑（来自地址簿；mock 时由 fixture 提供）。
struct ContactNode: Identifiable, Sendable, Hashable {
    var id: String
    var name: String
    var isCurrent: Bool
    var addresses: [String]
    var tokenAccount: String?
    var lastSeen: Date?

    init(id: String, name: String, isCurrent: Bool, addresses: [String] = [],
         tokenAccount: String? = nil, lastSeen: Date? = nil) {
        self.id = id
        self.name = name
        self.isCurrent = isCurrent
        self.addresses = addresses
        self.tokenAccount = tokenAccount
        self.lastSeen = lastSeen
    }

    init(computer: Computer, currentId: String?) {
        self.init(id: computer.id, name: computer.name, isCurrent: computer.id == currentId,
                  addresses: computer.addresses, tokenAccount: computer.tokenAccount, lastSeen: computer.lastSeen)
    }
}

/// 拉取一台电脑 Bot 目录的结果。
enum NodeStatus: Sendable, Equatable {
    case loading
    case online
    case offline
    /// 设备令牌被拒：需在设置里重新配对。
    case tokenRejected
    /// 电脑可达但 CC-Panes app 未运行（503）。
    case hostUnavailable
    /// 电脑端版本没有 `/api/bots`（404）。
    case unsupported
    case error(String)

    var isOnline: Bool { self == .online }

    var message: String? {
        switch self {
        case .loading, .online: nil
        case .offline: "电脑离线"
        case .tokenRejected: "令牌失效，请在右上角电脑面板重新配对"
        case .hostUnavailable: "电脑端 CC-Panes 未运行"
        case .unsupported: "该电脑的 CC-Panes 版本不支持 Bot 组网，请升级"
        case .error(let m): m
        }
    }
}

struct NodeDirectory: Sendable, Equatable {
    var status: NodeStatus
    var bots: [BotContact] = []
    /// 本次连通所用地址的类型（局域网 / Tailscale）。
    var via: AddressBook.Kind?
}

// MARK: - 分组 / 排序 / 搜索

struct ContactSection: Identifiable, Equatable {
    var node: ContactNode
    var directory: NodeDirectory
    var contacts: [BotContact]

    var id: String { node.id }
}

enum ContactsDirectory {
    /// 按电脑分组：当前电脑第一，其后在线 → 加载中 → 不可用，同档按名称；
    /// 组内：待审批 → 工作中 → 在线 → 未启动，同档按名称。搜索时隐藏无命中的电脑。
    static func sections(nodes: [ContactNode], directories: [String: NodeDirectory],
                         query: String = "") -> [ContactSection] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let built = nodes.map { node -> ContactSection in
            let directory = directories[node.id] ?? NodeDirectory(status: .loading)
            let online = directory.status.isOnline
            let contacts = directory.bots
                .filter { q.isEmpty || matches($0, node: node, query: q) }
                .sorted { a, b in
                    let ra = BotPresence(contact: a, nodeOnline: online).sortRank
                    let rb = BotPresence(contact: b, nodeOnline: online).sortRank
                    if ra != rb { return ra < rb }
                    return a.name.localizedStandardCompare(b.name) == .orderedAscending
                }
            return ContactSection(node: node, directory: directory, contacts: contacts)
        }
        return built
            .filter { q.isEmpty || !$0.contacts.isEmpty }
            .sorted { a, b in
                if a.node.isCurrent != b.node.isCurrent { return a.node.isCurrent }
                let ra = nodeRank(a.directory.status), rb = nodeRank(b.directory.status)
                if ra != rb { return ra < rb }
                return a.node.name.localizedStandardCompare(b.node.name) == .orderedAscending
            }
    }

    static func nodeRank(_ status: NodeStatus) -> Int {
        switch status {
        case .online: 0
        case .loading: 1
        default: 2
        }
    }

    static func matches(_ contact: BotContact, node: ContactNode, query q: String) -> Bool {
        [contact.name, contact.personaSummary, contact.engineId, contact.cwd, node.name]
            .contains { ($0 ?? "").lowercased().contains(q) }
    }

    /// 非当前电脑上的待审批总数（tab 角标；当前电脑的已计入「对话」tab）。
    static func remotePending(nodes: [ContactNode], directories: [String: NodeDirectory]) -> Int {
        nodes.filter { !$0.isCurrent }
            .compactMap { directories[$0.id] }
            .filter(\.status.isOnline)
            .flatMap(\.bots)
            .reduce(0) { $0 + $1.pendingPermissions }
    }
}

/// 「有新消息」：按 Bot 对话的 lastSeq 与本机记下的已读 seq 比较（只是一个点，不计数）。
struct ContactReadMarks: Sendable {
    nonisolated(unsafe) let defaults: UserDefaults
    static let key = "ccpanes.contacts.seenSeq.v1"

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    private var marks: [String: Int] { (defaults.dictionary(forKey: Self.key) as? [String: Int]) ?? [:] }

    func isUnread(_ contact: BotContact) -> Bool {
        guard let seq = contact.lastSeq, seq > 0 else { return false }
        guard let seen = marks[contact.id] else { return false } // 首次见到：不标（避免首装满屏点）
        return seq > seen
    }

    func markSeen(_ contact: BotContact) {
        var all = marks
        all[contact.id] = contact.lastSeq ?? 0
        defaults.set(all, forKey: Self.key)
    }

    /// 首次见到的 Bot 以当前 lastSeq 为基线（之后有新动静才亮）；电脑端重启后 seq 重新计数时
    /// 已读标记大于当前 lastSeq，回落到当前值，免得之后永远不亮。
    func reconcile(_ contacts: [BotContact]) {
        var all = marks
        var changed = false
        for contact in contacts {
            guard let seq = contact.lastSeq else { continue }
            if let seen = all[contact.id], seq >= seen { continue }
            all[contact.id] = seq
            changed = true
        }
        if changed { defaults.set(all, forKey: Self.key) }
    }
}
