import Foundation

/// 统一搜索（搜索 tab）的纯数据层：对话（活会话 + 历史）/ Bot（全部电脑）/ 项目 / 终端会话四类，
/// 分组返回；空查询给「需要你处理」建议。界面只读这里的结果，跳转目标也由这里给出。
enum UnifiedSearch {
    /// 结果所在电脑。
    struct Tag: Equatable, Hashable {
        var id: String
        var name: String
    }

    /// 一台电脑上的可搜内容。
    struct Computer {
        var tag: Tag
        var chats: [AcpChatSummary] = []
        var history: [AcpHistoryEntry] = []
        var workspaces: [Workspace] = []
        var mirror: [MirrorGroup] = []
    }

    struct Corpus {
        var computers: [Computer] = []
        /// 通讯录本来就按电脑分组（node = 电脑）。
        var contacts: [ContactSection] = []
        /// 本机 iPhone 上的对话（docs/112 §6）。
        var local: [LocalChatListItem] = []
    }

    static let localTag = Tag(id: LocalChatListItem.computerId, name: LocalChatListItem.computerName)

    enum Kind: String, CaseIterable, Sendable {
        case attention, chats, bots, projects, terminals

        var title: String {
            switch self {
            case .attention: "需要你处理"
            case .chats: "对话"
            case .bots: "Bot"
            case .projects: "项目"
            case .terminals: "终端会话"
            }
        }

        var symbol: String {
            switch self {
            case .attention: "hand.raised.fill"
            case .chats: "bubble.left.and.bubble.right"
            case .bots: "person.2"
            case .projects: "folder"
            case .terminals: "apple.terminal"
            }
        }
    }

    enum Hit: Identifiable, Equatable {
        case chat(AcpChatSummary, Tag)
        case local(LocalChatListItem)
        case history(AcpHistoryEntry, Tag)
        case bot(BotContact, Tag, online: Bool)
        case project(Workspace, WorkspaceProject, Tag)
        case terminal(MirrorCard, group: String, Tag)

        var tag: Tag {
            switch self {
            case .chat(_, let t), .history(_, let t), .bot(_, let t, _), .project(_, _, let t), .terminal(_, _, let t): t
            case .local: UnifiedSearch.localTag
            }
        }

        var id: String {
            let key = switch self {
            case .chat(let c, _): "chat:" + c.chatId
            case .local(let item): "local:" + item.id
            case .history(let h, _): "history:" + h.acpSessionId
            case .bot(let b, _, _): "bot:" + b.id
            case .project(let w, let p, _): "project:" + w.id + "/" + p.id
            case .terminal(let c, _, _): "terminal:" + c.sessionId
            }
            return tag.id + "|" + key
        }

        /// 点按后的去处（切 tab + 打开条目）。
        var destination: HomeDestination {
            switch self {
            case .chat(let c, let t):
                .chat(ChatRoute(chatId: c.chatId, title: c.displayTitle, engineId: c.engineId, computerId: t.id))
            case .local(let item):
                .chat(ChatRoute(chatId: item.id, title: item.title, engineId: "local", computerId: LocalChatListItem.computerId))
            case .history(let h, let t): .resume(h, computerId: t.id)
            case .bot(let b, _, let online): .contact(b.id, detail: !online)
            case .project(let w, let p, let t): .project(computerId: t.id, workspaceId: w.id, projectId: p.id)
            case .terminal(let c, _, let t):
                .terminal(TerminalRoute(sessionId: c.sessionId, title: c.displayTitle, computerId: t.id))
            }
        }
    }

    struct Section: Identifiable, Equatable {
        var kind: Kind
        var hits: [Hit]
        /// 截断前的命中总数（> hits.count 时界面提示「共 N 条」）。
        var total: Int
        var id: String { kind.rawValue }
    }

    /// 查询：按空白切词，每个词都要命中某个字段；主字段完全相等 < 前缀 < 包含 < 次要字段包含。
    static func results(_ query: String, in corpus: Corpus, limit: Int = 20) -> [Section] {
        let tokens = tokenize(query)
        guard !tokens.isEmpty else { return suggestions(corpus) }

        var chatHits: [(Int, Hit)] = []
        var projectHits: [(Int, Hit)] = []
        var terminalHits: [(Int, Hit)] = []
        for computer in corpus.computers {
            let tag = computer.tag
            chatHits += computer.chats.compactMap { chat in
                score(tokens, primary: chat.displayTitle, secondary: [chat.cwd, chat.engineId, tag.name])
                    .map { ($0, .chat(chat, tag)) }
            }
            let live = Set(computer.chats.compactMap(\.acpSessionId))
            chatHits += computer.history.filter { !live.contains($0.acpSessionId) }.compactMap { entry in
                // 历史排在同分的活会话之后
                score(tokens, primary: entry.title, secondary: [entry.cwd, entry.engineId, tag.name])
                    .map { ($0 + 1, .history(entry, tag)) }
            }
            projectHits += computer.workspaces.flatMap { ws in
                ws.projects.compactMap { project -> (Int, Hit)? in
                    score(tokens, primary: project.displayName, secondary: [project.path, ws.displayName, tag.name])
                        .map { ($0, .project(ws, project, tag)) }
                }
            }
            terminalHits += computer.mirror.flatMap { group in
                group.cards.compactMap { card -> (Int, Hit)? in
                    score(tokens, primary: card.displayTitle,
                          secondary: [card.projectName, card.cliTool, card.projectPath, group.title, tag.name])
                        .map { ($0, .terminal(card, group: group.title, tag)) }
                }
            }
        }

        chatHits += corpus.local.compactMap { item in
            score(tokens, primary: item.title,
                  secondary: [item.preview, item.providerName, item.modelId, "本机", LocalChatListItem.computerName])
                .map { ($0, .local(item)) }
        }

        let botHits: [(Int, Hit)] = corpus.contacts.flatMap { section in
            section.directory.bots.compactMap { bot -> (Int, Hit)? in
                score(tokens, primary: bot.name,
                      secondary: [bot.personaSummary, bot.engineId, bot.cwd, section.node.name])
                    .map { ($0, .bot(bot, Tag(id: section.node.id, name: section.node.name),
                                     online: section.directory.status.isOnline)) }
            }
        }

        return [(Kind.chats, chatHits), (.bots, botHits), (.projects, projectHits), (.terminals, terminalHits)]
            .compactMap { kind, scored in
                guard !scored.isEmpty else { return nil }
                let ranked = scored.enumerated()
                    .sorted { ($0.element.0, $0.offset) < ($1.element.0, $1.offset) }
                    .map(\.element.1)
                return Section(kind: kind, hits: Array(ranked.prefix(limit)), total: ranked.count)
            }
    }

    /// 空查询：各电脑待审批的对话（含 Bot 对话）、等待输入的终端。
    static func suggestions(_ corpus: Corpus) -> [Section] {
        var hits: [Hit] = []
        for computer in corpus.computers {
            hits += computer.chats.filter { ($0.pendingPermissions ?? 0) > 0 }.map { .chat($0, computer.tag) }
        }
        // 通讯录里有、但对应电脑的对话列表没拉到（mock / 版本差异）的 Bot 待审批
        let covered = Set(corpus.computers.filter { !$0.chats.isEmpty }.map(\.tag.id))
        for section in corpus.contacts where section.directory.status.isOnline && !covered.contains(section.node.id) {
            for bot in section.directory.bots where bot.pendingPermissions > 0 {
                hits.append(.bot(bot, Tag(id: section.node.id, name: section.node.name), online: true))
            }
        }
        for computer in corpus.computers {
            for group in computer.mirror {
                for card in group.cards where card.phase == .waiting {
                    hits.append(.terminal(card, group: group.title, computer.tag))
                }
            }
        }
        return hits.isEmpty ? [] : [Section(kind: .attention, hits: hits, total: hits.count)]
    }

    static func tokenize(_ query: String) -> [String] {
        query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
    }

    /// nil = 不命中；越小越靠前。
    static func score(_ tokens: [String], primary: String, secondary: [String?]) -> Int? {
        let main = primary.lowercased()
        let others = secondary.compactMap { $0?.lowercased() }
        var total = 0
        for token in tokens {
            if main == token { total += 0 }
            else if main.hasPrefix(token) { total += 1 }
            else if main.contains(token) { total += 2 }
            else if others.contains(where: { $0.contains(token) }) { total += 4 }
            else { return nil }
        }
        return total
    }
}
