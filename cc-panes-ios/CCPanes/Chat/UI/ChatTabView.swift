import SwiftUI

/// 「对话」tab：全部在线电脑的活会话（待审批分组置顶）+ 历史续接 + 新建（选电脑）。
/// 多台电脑时每行带电脑芯片；对话页绑定在它所在的电脑上。
struct ChatTabView: View {
    let hub: ConnectionHub
    /// 本机对话（伪电脑「本机 iPhone」，docs/112 §6）。
    private let local = LocalEnvironment.shared
    @Environment(HomeRouter.self) private var router
    @State private var path: [ChatRoute]
    @State private var showNew = false
    @State private var resumeError: String?

    init(hub: ConnectionHub) {
        self.hub = hub
        // 调试：`-openChat <chatId>` 启动后直接进入该对话（电脑在列表到达后补上）
        let debug = UserDefaults.standard.string(forKey: "openChat")
        var initial = debug.map { [ChatRoute(chatId: $0, title: "调试对话", engineId: "claude")] } ?? []
        #if DEBUG
        // `-openLocalChat <chatId|new>`：直接进入本机对话（new = 用第一个可用模型新建）
        if let localId = UserDefaults.standard.string(forKey: "openLocalChat"), !LocalEnvironment.debugRouteConsumed {
            LocalEnvironment.debugRouteConsumed = true // View.init 会被反复调用：只新建一次
            let env = LocalEnvironment.shared
            if localId == "new", let pick = env.defaultSelection() {
                initial = [LocalEnvironment.route(env.chats.create(providerId: pick.provider.id, modelId: pick.model))]
            } else if let chat = env.chats.chat(localId) ?? (localId == "latest" ? env.chats.chats.first : nil) {
                initial = [LocalEnvironment.route(chat)]
            }
        }
        #endif
        _path = State(initialValue: initial)
        #if DEBUG
        // `-openNewChat YES`：启动即打开「新建对话」（截图 / 联调用）
        _showNew = State(initialValue: UserDefaults.standard.bool(forKey: "openNewChat"))
        #endif
    }

    var body: some View {
        NavigationStack(path: $path) {
            list
                .overlay { emptyState }
                .refreshable { await hub.refreshAll() }
                .navigationTitle("对话")
                .homeTabChrome()
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("新建对话", systemImage: "square.and.pencil") { showNew = true }
                            .disabled(!canCreate)
                    }
                }
                .navigationDestination(for: ChatRoute.self) { route in
                    if LocalEnvironment.isLocal(route) {
                        LocalChatScreen(chatId: route.chatId, env: local) {
                            path.removeAll { $0 == route }
                        }
                    } else if let link = link(for: route), let chats = link.chats {
                        ChatScreen(route: route, service: chats.service, canWrite: link.canWrite)
                    } else {
                        ProgressView()
                    }
                }
                .sheet(isPresented: $showNew) {
                    NewChatSheet(hub: hub) { route in
                        showNew = false
                        path.append(route)
                    }
                }
                .alert("续接失败", isPresented: Binding(get: { resumeError != nil }, set: { if !$0 { resumeError = nil } })) {
                    Button("好") {}
                } message: {
                    Text(resumeError ?? "")
                }
        }
        #if DEBUG
        .task { await debugCreate() }
        #endif
        .onChange(of: entries.map(\.chat)) { _, _ in fillDebugRoute() }
        .onChange(of: router.pending, initial: true) { _, _ in consumeRoute() }
    }

    private struct Entry: Identifiable {
        var computerId: String
        var computer: String
        var chat: AcpChatSummary
        var id: String { computerId + "|" + chat.chatId }
    }

    private struct HistoryItem: Identifiable {
        var computerId: String
        var computer: String
        var entry: AcpHistoryEntry
        var id: String { computerId + "|" + entry.acpSessionId }
    }

    private var multi: Bool { hub.links.count > 1 }

    /// 本机 iPhone 永远可以新建（没有模型时新建页引导去设置）。
    private var canCreate: Bool { true }

    /// 「进行中」里一行：远程对话或本机对话，按更新时间混排。
    private enum ActiveRow: Identifiable {
        case remote(Entry)
        case local(LocalChatListItem)

        var id: String {
            switch self {
            case .remote(let entry): entry.id
            case .local(let item): LocalChatListItem.computerId + "|" + item.id
            }
        }

        var date: Date {
            switch self {
            case .remote(let entry): dateFromMillis(entry.chat.updatedAt) ?? .distantPast
            case .local(let item): item.updatedAt
            }
        }
    }

    /// 路由没带电脑（`-openChat` 调试）时：按 chatId 在各电脑里找。
    private func link(for route: ChatRoute) -> ComputerLink? {
        if !route.computerId.isEmpty { return hub.link(route.computerId) }
        if LocalEnvironment.isLocal(route) { return nil }
        return hub.links.first { $0.chats?.chats.contains { $0.chatId == route.chatId } == true }
            ?? hub.links.first { $0.status.isOnline && !$0.chatsUnsupported }
    }

    private var entries: [Entry] {
        hub.links.flatMap { link in
            (link.chats?.chats ?? []).map { Entry(computerId: link.id, computer: hub.name(link.id), chat: $0) }
        }
        .sorted { ($0.chat.updatedAt ?? 0) > ($1.chat.updatedAt ?? 0) }
    }

    private var historyItems: [HistoryItem] {
        hub.links.flatMap { link in
            (link.chats?.visibleHistory ?? []).map { HistoryItem(computerId: link.id, computer: hub.name(link.id), entry: $0) }
        }
        .sorted { ($0.entry.updatedAt ?? 0) > ($1.entry.updatedAt ?? 0) }
    }

    private func consumeRoute() {
        guard let destination = router.take(for: .chat) else { return }
        switch destination {
        case .chatList: path = []
        case .chat(let route): path = [route]
        case .resume(let entry, let computerId):
            path = []
            Task { await resume(entry, computerId: computerId) }
        default: break
        }
    }

    #if DEBUG
    /// 联调：`-acpCreate <engineId>|<cwd>` 启动即走「新建对话」同一条路径并进入（第一台支持对话的电脑）。
    private func debugCreate() async {
        guard let request = AcpDebugHooks.createRequest else { return }
        while !Task.isCancelled {
            if let chats = hub.links.first(where: { $0.status.isOnline && !$0.chatsUnsupported })?.chats {
                do {
                    path.append(try await chats.create(engineId: request.engineId, cwd: request.cwd))
                } catch {
                    resumeError = error.localizedDescription
                }
                return
            }
            try? await Task.sleep(for: .milliseconds(300))
        }
    }
    #endif

    /// `-openChat` 进入时只知道 chatId：列表到达后补上真实标题 / 引擎 / 电脑。
    private func fillDebugRoute() {
        guard let first = path.first, first.title == "调试对话",
              let entry = entries.first(where: { $0.chat.chatId == first.chatId }),
              let chats = hub.link(entry.computerId)?.chats else { return }
        path[0] = chats.route(for: entry.chat)
    }

    private var list: some View {
        let all = entries
        let attention = all.filter { ($0.chat.pendingPermissions ?? 0) > 0 }
        let active = (all.filter { ($0.chat.pendingPermissions ?? 0) == 0 }.map(ActiveRow.remote)
            + local.chats.listItems.map(ActiveRow.local))
            .sorted { $0.date > $1.date }
        return List {
            ForEach(hub.links) { link in
                if let issue = chatIssue(link) {
                    LinkIssueRow(name: hub.name(link.id), message: issue.0, symbol: issue.1)
                }
            }
            if !attention.isEmpty {
                Section {
                    ForEach(attention) { chatLink($0) }
                } header: {
                    SectionLabel(title: "需要你处理", systemImage: "hand.raised.fill", trailing: "\(attention.count)", tint: .orange)
                }
            }
            if !active.isEmpty {
                Section {
                    ForEach(active) { row in
                        switch row {
                        case .remote(let entry): chatLink(entry)
                        case .local(let item): localLink(item)
                        }
                    }
                } header: {
                    SectionLabel(title: "进行中", systemImage: "bubble.left.and.bubble.right", trailing: "\(active.count)")
                }
            }
            let history = historyItems
            if !history.isEmpty {
                Section {
                    ForEach(history) { item in
                        Button { Task { await resume(item.entry, computerId: item.computerId) } } label: {
                            HistoryRow(entry: item.entry, engines: hub.link(item.computerId)?.chats?.engines ?? [],
                                       computer: multi ? item.computer : nil)
                        }
                        .tint(.primary)
                        .disabled(hub.link(item.computerId)?.canWrite != true)
                    }
                } header: {
                    SectionLabel(title: "历史 · 点按续接", systemImage: "clock.arrow.circlepath")
                }
            }
        }
        .listStyle(.insetGrouped)
        .listSectionSpacing(14)
        .readableContentWidth()
    }

    /// 某台电脑上对话不可用的原因（连不上 / 未运行 / 版本较旧）。
    private func chatIssue(_ link: ComputerLink) -> (String, String)? {
        if let issue = link.issue { return (issue.message, issue.symbol) }
        if link.chatsUnsupported { return ("版本较旧，暂不支持对话", "arrow.up.circle") }
        if let error = link.chats?.error { return (error, "exclamationmark.triangle") }
        return nil
    }

    private func localLink(_ item: LocalChatListItem) -> some View {
        NavigationLink(value: ChatRoute(chatId: item.id, title: item.title, engineId: "local",
                                        computerId: LocalChatListItem.computerId)) {
            LocalChatRow(item: item)
        }
        .swipeActions {
            Button("删除", role: .destructive) { local.chats.delete(item.id) }
        }
    }

    private func chatLink(_ entry: Entry) -> some View {
        NavigationLink(value: ChatRoute(chatId: entry.chat.chatId, title: entry.chat.displayTitle,
                                        engineId: entry.chat.engineId, computerId: entry.computerId)) {
            ChatSummaryRow(chat: entry.chat, engines: hub.link(entry.computerId)?.chats?.engines ?? [],
                           computer: multi ? entry.computer : nil)
        }
    }

    @ViewBuilder private var emptyState: some View {
        let loaded = hub.links.contains { $0.chats?.loaded == true } || hub.links.allSatisfy { !$0.status.isOnline && $0.status != .connecting }
        if !loaded && local.chats.chats.isEmpty {
            ProgressView()
        } else if entries.isEmpty, historyItems.isEmpty, local.chats.chats.isEmpty, loaded || hub.links.isEmpty {
            ContentUnavailableView {
                Label("还没有对话", systemImage: "bubble.left.and.text.bubble.right")
            } description: {
                Text(hub.links.isEmpty
                     ? "点右上角新建，用本机模型在手机上直接对话"
                     : "点右上角新建：在电脑上选引擎和项目，或用本机模型在手机上直接对话")
            }
        }
    }

    private func resume(_ entry: AcpHistoryEntry, computerId: String) async {
        guard let chats = hub.link(computerId)?.chats else { return }
        do {
            let route = try await chats.create(engineId: entry.engineId, cwd: entry.cwd, resume: entry.acpSessionId)
            path.append(ChatRoute(chatId: route.chatId, title: entry.title, engineId: entry.engineId, computerId: computerId))
        } catch {
            resumeError = error.localizedDescription
        }
    }
}

struct ChatSummaryRow: View {
    let chat: AcpChatSummary
    let engines: [AcpEngineInfo]
    /// 多电脑时标注所在电脑。
    var computer: String?

    private var phase: AcpChatPhase { AcpChatPhase(chat.status) }
    private var pending: Int { chat.pendingPermissions ?? 0 }

    var body: some View {
        HStack(spacing: 12) {
            EngineIcon(engineId: chat.engineId)
                .overlay(alignment: .bottomTrailing) {
                    Circle().fill(phaseColor).frame(width: 10, height: 10)
                        .overlay(Circle().strokeBorder(DK.card, lineWidth: 2))
                        .offset(x: 3, y: 3)
                }
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(chat.displayTitle).font(.body.weight(.semibold)).lineLimit(1)
                    Spacer(minLength: 4)
                    if let ago = shortRelative(dateFromMillis(chat.updatedAt)) {
                        Text(ago).font(.caption).foregroundStyle(.secondary).fixedSize()
                    }
                }
                HStack(spacing: 5) {
                    if let computer { ComputerChip(name: computer) }
                    Image(systemName: originSymbol).imageScale(.small)
                    Text(subtitle).lineLimit(1)
                    Spacer(minLength: 4)
                    if pending > 0 {
                        Text("\(pending) 待审批")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2)
                            .background(.orange, in: Capsule())
                            .fixedSize()
                    } else if phase == .generating {
                        Text("生成中").font(.caption.weight(.semibold)).foregroundStyle(.blue)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private var subtitle: String {
        var parts = [AcpEngineStyle.label(chat.engineId, engines: engines)]
        if let cwd = chat.cwd { parts.append(pathBasename(cwd)) }
        if phase != .generating, phase != .ready { parts.append(phase.label) }
        return parts.joined(separator: " · ")
    }

    private var originSymbol: String {
        if chat.isBot { return "person.crop.circle.badge.checkmark" }
        return chat.isMobile ? "iphone" : "desktopcomputer"
    }

    private var phaseColor: Color {
        if pending > 0 { return .orange }
        switch phase {
        case .generating: return .blue
        case .ready: return .green
        case .starting: return .orange
        default: return .gray
        }
    }
}

struct HistoryRow: View {
    let entry: AcpHistoryEntry
    let engines: [AcpEngineInfo]
    var computer: String?

    var body: some View {
        HStack(spacing: 12) {
            EngineIcon(engineId: entry.engineId).saturation(0.3)
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(entry.title.isEmpty ? "未命名对话" : entry.title).lineLimit(1)
                    Spacer(minLength: 4)
                    if let ago = shortRelative(entry.updatedDate) {
                        Text(ago).font(.caption).foregroundStyle(.secondary).fixedSize()
                    }
                }
                HStack(spacing: 5) {
                    if let computer { ComputerChip(name: computer) }
                    Text("\(AcpEngineStyle.label(entry.engineId, engines: engines)) · \(pathBasename(entry.cwd))")
                        .lineLimit(1)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
    }
}

struct EngineIcon: View {
    let engineId: String
    var size: CGFloat = 40

    var body: some View {
        CLIGlyph(tool: engineId, size: size)
    }
}
