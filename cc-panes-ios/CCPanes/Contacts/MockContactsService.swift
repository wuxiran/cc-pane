import Foundation

/// 通讯录离线样例（`-mockContacts YES`）：三台电脑（本机在线 / Tailscale 在线 / 离线）+ 各状态 Bot，
/// 覆盖待审批、工作中、在线、未启动、四种远程策略。对话落到进程内 MockAcpService。
actor MockContactsService: ContactsService {
    static let shared = MockContactsService()

    static let macId = "mock-mac"
    static let winId = "mock-win"
    static let nasId = "mock-nas"

    private var policies: [String: (RemotePolicy, [String])] = [:]

    nonisolated var canEditPolicy: Bool { true }

    @MainActor
    func nodes(computers: [Computer], currentId: String?) -> [ContactNode] {
        [ContactNode(id: Self.macId, name: "我的 MacBook Pro", isCurrent: true, addresses: ["http://192.168.1.20:18080"]),
         ContactNode(id: Self.winId, name: "公司台式机", isCurrent: false, addresses: ["http://100.88.12.4:18080"]),
         ContactNode(id: Self.nasId, name: "家里 Mac mini", isCurrent: false, addresses: ["http://192.168.1.40:18080"],
                     lastSeen: Date().addingTimeInterval(-3 * 86_400))]
    }

    func beginRefresh() async {}

    func directory(of node: ContactNode) async -> NodeDirectory {
        try? await Task.sleep(for: .milliseconds(node.id == Self.winId ? 450 : 150))
        switch node.id {
        case Self.macId: return NodeDirectory(status: .online, bots: apply(Self.macBots), via: .lan)
        case Self.winId: return NodeDirectory(status: .online, bots: apply(Self.winBots), via: .tailscale)
        default: return NodeDirectory(status: .offline)
        }
    }

    func chatService(for contact: BotContact, node: ContactNode) async -> (any AcpService)? {
        guard node.id != Self.nasId else { return nil }
        let mock = MockAcpService.shared
        return BotChatService(base: mock, botChatId: contact.chatId, dormantPoll: .seconds(1)) { text, promptId in
            await mock.ensureBotChat(chatId: contact.chatId, botId: contact.botId, engineId: contact.engineId,
                                     cwd: contact.cwd ?? "~/.cc-panes/bots/\(contact.botId)/home", title: contact.name)
            try await mock.prompt(chatId: contact.chatId, text: text, promptId: promptId)
        }
    }

    func update(_ change: BotRemoteChange, for contact: BotContact, node: ContactNode) async throws -> BotContact? {
        try await Task.sleep(for: .milliseconds(300))
        if change.policy == .full && !change.confirmFull {
            throw ContactsHTTPError.status(400, code: "BOT_FULL_CONFIRM_REQUIRED", message: "")
        }
        var bot = contact
        bot.remotePolicy = change.policy ?? contact.remotePolicy
        bot.remoteAllowKinds = change.allowKinds ?? contact.remoteAllowKinds
        policies[contact.id] = (bot.remotePolicy, bot.remoteAllowKinds)
        return bot
    }

    private func apply(_ bots: [BotContact]) -> [BotContact] {
        bots.map { bot in
            var bot = bot
            if let (policy, kinds) = policies[bot.id] {
                bot.remotePolicy = policy
                bot.remoteAllowKinds = kinds
            }
            return bot
        }
    }

    // `bot-reviewer` 与 MockAcpService 里已有的 Bot 对话同 id：点开能看到一段剧本。
    static let macBots: [BotContact] = [
        BotContact(nodeId: macId, botId: "reviewer", name: "代码评审", avatar: "🧐", color: "#7c3aed", engineId: "claude",
                   personaSummary: "严格的 Rust / Swift 评审，只提有证据的问题", status: "ready", remotePolicy: .askOrigin,
                   cwd: "/Users/dev/workspace/cc-pane", chatId: "bot-reviewer", pendingPermissions: 1, lastSeq: 42),
        BotContact(nodeId: macId, botId: "daily", name: "日报助手", avatar: "📰", color: "#0ea5e9", engineId: "codex",
                   personaSummary: "每天汇总 git log 与待办，生成中文日报", status: "generating", remotePolicy: .allowlist,
                   remoteAllowKinds: ["read", "search"], cwd: nil, chatId: "bot-daily", lastSeq: 18),
        BotContact(nodeId: macId, botId: "ops", name: "运维值班", avatar: "🛠️", color: "#ef4444", engineId: "gemini",
                   personaSummary: "盯 CI 与发版流水线，失败时自动排查", status: "ready", remotePolicy: .full,
                   cwd: "/Users/dev/workspace/infra", chatId: "bot-ops"),
    ]

    static let winBots: [BotContact] = [
        BotContact(nodeId: winId, botId: "builder", name: "构建守护", avatar: "", color: "#16a34a", engineId: "codex",
                   personaSummary: "Windows 下跑 cargo build 与 MSI 打包", status: "idle", remotePolicy: .deny,
                   cwd: "D:\\work\\cc-pane", chatId: "bot-builder"),
        BotContact(nodeId: winId, botId: "writer", name: "文档写手", avatar: "✍️", color: nil, engineId: "claude",
                   personaSummary: "把设计讨论整理成 docs/ 下的正式文档", status: "ready", remotePolicy: .askOrigin,
                   cwd: "D:\\work\\cc-book-workspace", chatId: "bot-writer", lastSeq: 7),
    ]
}
