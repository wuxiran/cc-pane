import SwiftUI

/// 搜索 tab（`Tab(role: .search)`）：跨全部在线电脑统一搜对话 / Bot / 项目 / 终端会话，分组展示，
/// 点按切到对应 tab 并打开条目。空查询显示「需要你处理」。
/// iOS 26 上搜索框随 Liquid Glass tab 栏落在屏幕底部。
struct SearchTabView: View {
    let hub: ConnectionHub
    @Environment(HomeRouter.self) private var router
    @State private var query = UserDefaults.standard.string(forKey: "searchQuery") ?? ""

    var body: some View {
        NavigationStack {
            let sections = UnifiedSearch.results(query, in: SearchCorpus.build(hub))
            List {
                ForEach(sections) { section in
                    Section {
                        ForEach(section.hits) { hit in
                            Button { router.open(hit.destination) } label: { SearchHitRow(hit: hit, showComputer: showComputer) }
                                .tint(.primary)
                        }
                    } header: {
                        SectionLabel(title: section.kind.title, systemImage: section.kind.symbol,
                                     trailing: section.total > section.hits.count
                                        ? "\(section.hits.count) / \(section.total)" : "\(section.total)",
                                     tint: section.kind == .attention ? .orange : .secondary)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .listSectionSpacing(14)
            .readableContentWidth()
            .overlay { empty(sections) }
            .navigationTitle("搜索")
            .searchable(text: $query, prompt: "对话、Bot、项目、终端")
            .homeTabChrome()
        }
    }

    private var showComputer: Bool { hub.links.count > 1 }

    @ViewBuilder private func empty(_ sections: [UnifiedSearch.Section]) -> some View {
        if sections.isEmpty {
            if query.trimmingCharacters(in: .whitespaces).isEmpty {
                ContentUnavailableView {
                    Label("搜索全部电脑", systemImage: "magnifyingglass")
                } description: {
                    Text("对话、Bot、项目和终端会话；也可以输入电脑名，只看那台电脑上的内容")
                }
            } else {
                ContentUnavailableView.search(text: query)
            }
        }
    }
}

/// 搜索结果行：类型图标 + 标题 + 副标题（所在电脑 / 项目 / 状态）。
private struct SearchHitRow: View {
    let hit: UnifiedSearch.Hit
    let showComputer: Bool

    var body: some View {
        HStack(spacing: 12) {
            icon
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(title).font(.body.weight(.medium)).lineLimit(1)
                    Spacer(minLength: 4)
                    trailing
                }
                HStack(spacing: 6) {
                    if isLocal { LocalChip() } else if showComputer || isBot { ComputerChip(name: hit.tag.name, online: online) }
                    Text(subtitle).lineLimit(1)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 1)
        .accessibilityElement(children: .combine)
    }

    private var isBot: Bool { if case .bot = hit { true } else { false } }
    private var isLocal: Bool { if case .local = hit { true } else { false } }
    private var online: Bool { if case .bot(_, _, let online) = hit { online } else { true } }

    @ViewBuilder private var icon: some View {
        switch hit {
        case .chat(let chat, _): EngineIcon(engineId: chat.engineId, size: 34)
        case .local: LocalChatIcon(size: 34)
        case .history(let entry, _): EngineIcon(engineId: entry.engineId, size: 34).saturation(0.3)
        case .bot(let bot, _, let online):
            BotAvatar(contact: bot, size: 34, presence: BotPresence(contact: bot, nodeOnline: online))
        case .project(_, let project, _): ProjectMonogram(name: project.displayName)
        case .terminal(let card, _, _): CLIGlyph(tool: card.cliTool, size: 34)
        }
    }

    private var title: String {
        switch hit {
        case .chat(let chat, _): chat.displayTitle
        case .local(let item): item.title
        case .history(let entry, _): entry.title.isEmpty ? "未命名对话" : entry.title
        case .bot(let bot, _, _): bot.name
        case .project(_, let project, _): project.displayName
        case .terminal(let card, _, _): card.displayTitle
        }
    }

    private var subtitle: String {
        switch hit {
        case .chat(let chat, _):
            [AcpEngineStyle.label(chat.engineId), chat.cwd.map(pathBasename)].compactMap { $0 }.joined(separator: " · ")
        case .local(let item): item.providerName + " · " + item.modelId
        case .history(let entry, _): "历史 · " + pathBasename(entry.cwd)
        case .bot(let bot, _, _): bot.personaSummary ?? AcpEngineStyle.label(bot.engineId)
        case .project(let ws, let project, _):
            ws.displayName == project.displayName ? abbreviatePath(project.path) : ws.displayName + " · " + abbreviatePath(project.path)
        case .terminal(let card, let group, _):
            [group, card.projectName].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        }
    }

    @ViewBuilder private var trailing: some View {
        switch hit {
        case .chat(let chat, _) where (chat.pendingPermissions ?? 0) > 0:
            pendingCapsule(chat.pendingPermissions ?? 0)
        case .bot(let bot, _, _) where bot.pendingPermissions > 0:
            pendingCapsule(bot.pendingPermissions)
        case .terminal(let card, _, _):
            PhaseCapsule(phase: card.phase)
        default:
            EmptyView()
        }
    }

    private func pendingCapsule(_ n: Int) -> some View {
        Text("\(n) 待审批")
            .font(.caption2.weight(.bold))
            .foregroundStyle(.white)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(.orange, in: Capsule())
            .fixedSize()
    }
}
