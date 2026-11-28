import SwiftUI

/// 「终端」tab：全部在线电脑的布局镜像。标题即范围切换器（点按弹出布局 / 电脑选择器），
/// 内容区左右翻页在当前范围的布局间切换（首页「全部」）；按 pane 顺序排卡，点卡接管终端。
struct MirrorTabView: View {
    let hub: ConnectionHub
    @Environment(HomeRouter.self) private var router
    @State private var path: [TerminalRoute]
    @State private var pendingKill: (card: MirrorCard, computerId: String)?
    @State private var killError: String?
    @State private var scope = MirrorScope()
    @State private var showPicker: Bool
    /// `-mockMirror` 下追加的虚拟电脑（测多电脑密度）；启动时生成一次。
    @State private var mockExtras: [MirrorComputer]

    private static let allPage = "__all__"

    init(hub: ConnectionHub) {
        self.hub = hub
        let defaults = UserDefaults.standard
        // 调试：`-openSession <id>` 启动后直接进入该会话终端（电脑按会话所在补上）
        let debug = defaults.string(forKey: "openSession")
        _path = State(initialValue: debug.map { [TerminalRoute(sessionId: $0, title: "调试会话")] } ?? [])
        // 调试：`-layoutPicker YES` 启动即打开选择器
        _showPicker = State(initialValue: defaults.bool(forKey: "layoutPicker"))
        var extras: [MirrorComputer] = []
        #if DEBUG
        if defaults.bool(forKey: "mockMirror") {
            extras = MirrorFixture.extraComputers().map { entry in
                MirrorComputer(id: entry.id, name: entry.name, groups: entry.state.groups, isOnline: entry.online,
                               route: entry.online ? "局域网" : nil, savedAt: entry.state.savedAt)
            }
        }
        #endif
        _mockExtras = State(initialValue: extras)
    }

    var body: some View {
        NavigationStack(path: $path) {
            pages
                .background(DK.canvas)
                .overlay { emptyState }
                .navigationTitle("终端")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { toolbar }
                .homeTabChrome()
                .navigationDestination(for: TerminalRoute.self) { route in
                    if let link = link(for: route), let api = link.api {
                        TerminalScreen(sessionId: route.sessionId, title: route.title, api: api, canWrite: link.canWrite)
                    } else {
                        ProgressView()
                    }
                }
                .sheet(isPresented: $showPicker) {
                    LayoutPickerSheet(computers: computers, resolved: resolved, current: scope,
                                      status: { hub.link($0)?.status }) { next in
                        withAnimation(.snappy) { scope = next }
                    }
                }
                .confirmationDialog("关闭会话？", isPresented: killBinding, titleVisibility: .visible,
                                    presenting: pendingKill) { target in
                    Button("关闭会话", role: .destructive) { Task { await kill(target.card, on: target.computerId) } }
                } message: { target in
                    Text("将终止「\(target.card.displayTitle)」及其整棵进程树。")
                }
                .alert("关闭失败", isPresented: errorBinding) {
                    Button("好") {}
                } message: {
                    Text(killError ?? "")
                }
        }
        .onChange(of: router.pending, initial: true) { _, _ in
            guard case .terminal(let route)? = router.take(for: .terminal) else { return }
            path = [route]
        }
    }

    // MARK: - 数据

    /// 全部电脑（含 mock 虚拟电脑）；多电脑时组带上电脑名，id 已带电脑前缀不冲突。
    private var computers: [MirrorComputer] {
        let multi = hub.links.count + mockExtras.count > 1
        let real = hub.links.map { link in
            let name = hub.name(link.id)
            let groups = (link.mirror?.state.groups ?? []).map { group in
                var tagged = group
                tagged.computerId = link.id
                tagged.computerName = multi ? name : nil
                return tagged
            }
            return MirrorComputer(id: link.id, name: name, groups: groups, isOnline: link.status.isOnline,
                                  route: HomeStatus.routeLabel(link.via), savedAt: link.mirror?.state.savedAt)
        }
        return real + mockExtras.map { extra in
            var tagged = extra
            tagged.groups = extra.groups.map { group in
                var g = group
                g.computerId = extra.id
                g.computerName = extra.name
                return g
            }
            return tagged
        }
    }

    private var resolved: ResolvedMirrorScope {
        resolveMirrorScope(scope, computers: computers,
                           preferredLayoutName: UserDefaults.standard.string(forKey: "mirrorLayout"))
    }

    /// 范围内的电脑连接（出错提示 / 空态判断用）。
    private var scopedLinks: [ComputerLink] {
        let id = resolved.computerId
        return hub.links.filter { id == nil || $0.id == id }
    }

    private func link(for route: TerminalRoute) -> ComputerLink? {
        if !route.computerId.isEmpty { return hub.link(route.computerId) }
        return hub.links.first { $0.mirror?.state.groups.contains { $0.cards.contains { $0.sessionId == route.sessionId } } == true }
            ?? hub.links.first(where: \.status.isOnline)
    }

    // MARK: - 翻页

    /// 多页时用分页容器（左右滑切布局，纵向滚动与行左滑归各页 List 处理）；单页直接放 List。
    @ViewBuilder private var pages: some View {
        let resolved = self.resolved
        let ids = resolved.pageIds
        if ids.count > 1 {
            TabView(selection: pageSelection) {
                ForEach(ids, id: \.self) { id in
                    page(id, in: resolved).tag(id ?? Self.allPage)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
        } else {
            page(ids.first ?? nil, in: resolved)
        }
    }

    private var pageSelection: Binding<String> {
        Binding(get: { resolved.layout?.id ?? Self.allPage },
                set: { id in scope = scope.paging(to: id == Self.allPage ? nil : id) })
    }

    private func page(_ id: String?, in resolved: ResolvedMirrorScope) -> some View {
        ScrollViewReader { proxy in
            List {
                ForEach(scopedLinks) { link in
                    if let issue = link.issue {
                        LinkIssueRow(name: hub.name(link.id), message: issue.message, symbol: issue.symbol).cardRow()
                    } else if let error = link.mirror?.error {
                        LinkIssueRow(name: hub.name(link.id), message: error, symbol: "exclamationmark.triangle").cardRow()
                    }
                }
                if let id, let group = resolved.groups.first(where: { $0.id == id }) {
                    if LayoutStrip.isUseful(group) {
                        LayoutStrip(group: group) { ordinal in
                            if let card = group.cards.first(where: { $0.paneOrdinal == ordinal }) {
                                withAnimation(.snappy) { proxy.scrollTo(card.id, anchor: .top) }
                            }
                        }
                        .cardRow(top: 6, bottom: 2)
                    }
                    ForEach(group.cards) { card in row(card, computerId: group.computerId).id(card.id) }
                } else if id == nil {
                    ForEach(resolved.groups) { group in
                        sectionHeader(group).cardRow(top: 14, bottom: 2)
                        ForEach(group.cards) { card in row(card, computerId: group.computerId) }
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(DK.canvas)
            .readableContentWidth()
            .refreshable { await hub.refreshAll() }
            #if DEBUG
            // 调试：`-autoScroll YES` 3 秒后滚到列表底部（截图验证 tab 栏下滑收起）
            .task {
                guard UserDefaults.standard.bool(forKey: "autoScroll"), id == resolved.layout?.id else { return }
                try? await Task.sleep(for: .seconds(3))
                let last = resolved.groups.first { $0.id == id }?.cards.last
                if let last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
            }
            #endif
        }
    }

    /// 「全部」页的布局分节头：缩略图 + 名称 + 电脑 + 相位汇总；点按进入该布局页。
    private func sectionHeader(_ group: MirrorGroup) -> some View {
        Button {
            withAnimation(.snappy) { scope = scope.paging(to: group.id) }
        } label: {
            HStack(spacing: 10) {
                LayoutPreview(group: group)
                    .frame(width: 34, height: 22)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 4) {
                        if group.isCurrentLayout {
                            Image(systemName: "desktopcomputer")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(Color.accentColor)
                                .accessibilityLabel("桌面当前布局")
                        }
                        Text(group.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                    }
                    if let computer = group.computerName {
                        Text(computer).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer(minLength: 4)
                PhaseCountsRow(counts: group.counts)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("查看该布局")
    }

    private func row(_ card: MirrorCard, computerId: String) -> some View {
        let link = hub.link(computerId)
        let canWrite = link?.canWrite ?? false
        return Button {
            path.append(TerminalRoute(sessionId: card.sessionId, title: card.displayTitle, computerId: computerId))
        } label: {
            MirrorCardRow(card: card, preview: link?.mirror?.previews[card.sessionId])
        }
        .buttonStyle(PressableCardStyle())
        .cardRow()
        .task(id: "\(card.sessionId)#\((link?.mirror?.tick ?? 0) / 3)") { await link?.mirror?.loadPreview(for: card.sessionId) }
        .swipeActions(edge: .trailing) {
            if canWrite {
                Button("关闭", systemImage: "xmark", role: .destructive) { pendingKill = (card, computerId) }
            }
        }
        .contextMenu {
            if canWrite {
                Button("关闭会话", systemImage: "xmark.circle", role: .destructive) { pendingKill = (card, computerId) }
            }
        }
    }

    @ViewBuilder private var emptyState: some View {
        let links = scopedLinks
        let loaded = links.contains { $0.mirror?.loaded == true } || links.allSatisfy { !$0.status.isOnline && $0.status != .connecting }
        if !loaded && resolved.groups.isEmpty {
            ProgressView()
        } else if resolved.groups.isEmpty {
            let snapshot = links.contains { $0.mirror?.state.snapshotAvailable == true }
            ContentUnavailableView {
                Label(snapshot ? "电脑当前没有在跑的会话" : "电脑未运行或未打开 CC-Panes 前端",
                      systemImage: "desktopcomputer.trianglebadge.exclamationmark")
            } description: {
                Text("到「工作区」点按项目即可启动一个")
            }
        }
    }

    // MARK: - 标题

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .principal) { headerButton }
        ToolbarItemGroup(placement: .topBarTrailing) {
            if let id = resolved.layout?.computerId ?? resolved.computerId,
               hub.link(id)?.mirror?.state.stale == true {
                StatusPill(systemImage: "clock.badge.exclamationmark", text: "数据陈旧", color: .orange)
            }
        }
    }

    /// 标题 = 当前范围（布局名 ▾ + 页码）；副标题 = 电脑 · 会话数 · 同步时间。点按打开选择器。
    private var headerButton: some View {
        let resolved = self.resolved
        let header = mirrorHeader(resolved, computers: computers)
        return Button { showPicker = true } label: {
            VStack(spacing: 0) {
                HStack(spacing: 5) {
                    Text(header.title)
                        .font(.headline)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let page = resolved.pageLabel {
                        Text(page)
                            .font(.caption2.weight(.semibold))
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(DK.inset, in: Capsule())
                            .contentTransition(.numericText())
                    }
                    Image(systemName: "chevron.down")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.secondary)
                }
                TimelineView(.periodic(from: .now, by: 5)) { context in
                    Text(subtitle(header, now: context.date))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: 260)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("切换布局，当前 \(header.title)\(resolved.pageLabel.map { "，第 \($0)" } ?? "")")
        .accessibilityHint(header.subtitle)
    }

    private func subtitle(_ header: MirrorHeader, now: Date) -> String {
        guard let saved = header.savedAt else { return header.subtitle }
        return header.subtitle + " · " + syncAgoText(saved, now: now)
    }

    // MARK: - 关闭会话

    private var killBinding: Binding<Bool> {
        Binding(get: { pendingKill != nil }, set: { if !$0 { pendingKill = nil } })
    }

    private var errorBinding: Binding<Bool> {
        Binding(get: { killError != nil }, set: { if !$0 { killError = nil } })
    }

    private func kill(_ card: MirrorCard, on computerId: String) async {
        guard let mirror = hub.link(computerId)?.mirror else { return }
        do {
            try await mirror.kill(card.sessionId)
        } catch APIError.forbidden {
            killError = "远程只读模式已拦截。可在桌面端开启「允许已登录的远程会话写入」。"
        } catch {
            killError = error.localizedDescription
        }
    }
}
