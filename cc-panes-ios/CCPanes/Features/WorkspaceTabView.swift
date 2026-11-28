import SwiftUI

/// 「工作区」tab：按电脑分组（多台时）→ 最近启动（横滑卡）+ 可折叠的工作空间分组 → 项目行。
/// 点项目 → 启动 sheet（含该项目正在运行的会话）；行尾「+」/ 左滑 / 长按 = 一键启动，启动在项目所在的电脑上。
/// 顶部搜索已并入统一搜索 tab（项目 / 工作空间名都能搜到，点结果直接打开启动 sheet）。
struct WorkspaceTabView: View {
    let hub: ConnectionHub
    @Environment(HomeRouter.self) private var router
    @State private var path: [TerminalRoute] = []
    @State private var launching: LaunchTarget?
    @State private var expanded: Set<String> = []
    @State private var seeded: Set<String> = []
    @State private var quickError: String?

    var body: some View {
        NavigationStack(path: $path) {
            list
                .overlay { emptyState }
                .refreshable { await hub.refreshAll() }
                .navigationTitle("工作区")
                .homeTabChrome()
                .navigationDestination(for: TerminalRoute.self) { route in
                    if let link = hub.link(route.computerId), let api = link.api {
                        TerminalScreen(sessionId: route.sessionId, title: route.title, api: api, canWrite: link.canWrite)
                    } else {
                        ProgressView()
                    }
                }
                .sheet(item: $launching) { target in launchSheet(target) }
                .alert("启动失败", isPresented: Binding(get: { quickError != nil }, set: { if !$0 { quickError = nil } })) {
                    Button("好") {}
                } message: {
                    Text(quickError ?? "")
                }
                .onChange(of: hub.links.map { $0.workspaces?.workspaces ?? [] }, initial: true) { _, _ in seedExpansion() }
        }
        .onChange(of: router.pending, initial: true) { _, _ in consumeRoute() }
    }

    private var multi: Bool { hub.links.count > 1 }

    @ViewBuilder private func launchSheet(_ target: LaunchTarget) -> some View {
        if let link = hub.link(target.computerId), let workspaces = link.workspaces, let mirror = link.mirror {
            LaunchSheet(target: target, records: workspaces.resumable(for: target.project),
                        running: sessions(link)[normalizeProjectPath(target.project.path)] ?? [],
                        previews: mirror.previews, canWrite: link.canWrite,
                        onOpen: { card in
                            launching = nil
                            path.append(TerminalRoute(sessionId: card.sessionId, title: card.displayTitle, computerId: link.id))
                        }) { tool, resumeId in
                let id = try await mirror.launch(project: target.project, workspaceName: target.workspace.name,
                                                 tool: tool, resumeId: resumeId)
                launching = nil
                path.append(TerminalRoute(sessionId: id, title: target.project.displayName, computerId: link.id))
            }
        }
    }

    private func consumeRoute() {
        guard case .project(let computerId, let workspaceId, let projectId)? = router.take(for: .workspace),
              let ws = hub.link(computerId)?.workspaces?.workspaces.first(where: { $0.id == workspaceId }),
              let project = ws.projects.first(where: { $0.id == projectId }) else { return }
        expanded.insert(key(computerId, ws.id))
        launching = LaunchTarget(computerId: computerId, workspace: ws, project: project)
    }

    // MARK: - Derived

    private func key(_ computerId: String, _ workspaceId: String) -> String { computerId + "|" + workspaceId }

    /// 规范化项目路径 → 该项目在这台电脑上的活会话卡（电脑布局 + 手机远程 + 孤儿）。
    private func sessions(_ link: ComputerLink) -> [String: [MirrorCard]] {
        var map: [String: [MirrorCard]] = [:]
        for group in link.mirror?.state.groups ?? [] {
            for card in group.cards {
                guard let path = card.projectPath, !path.isEmpty else { continue }
                map[normalizeProjectPath(path), default: []].append(card)
            }
        }
        return map
    }

    // MARK: - List

    private var list: some View {
        List {
            ForEach(hub.links) { link in computerBlock(link) }
        }
        .listStyle(.insetGrouped)
        .listSectionSpacing(14)
        .readableContentWidth()
    }

    @ViewBuilder private func computerBlock(_ link: ComputerLink) -> some View {
        let live = sessions(link)
        let workspaces = (link.workspaces?.workspaces ?? []).filter { !$0.projects.isEmpty }
        if multi {
            Section {
                if let issue = link.issue {
                    LinkIssueRow(name: hub.name(link.id), message: issue.message, symbol: issue.symbol)
                } else if link.status.isOnline, !link.canWrite {
                    Label("只读：电脑端未允许远程写入，无法新建会话", systemImage: "lock.fill")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            } header: {
                ComputerHeader(name: hub.name(link.id), link: link,
                               projects: workspaces.reduce(0) { $0 + $1.projects.count },
                               live: link.mirror?.state.sessionCount ?? 0)
            }
        } else if let issue = link.issue {
            LinkIssueRow(name: hub.name(link.id), message: issue.message, symbol: issue.symbol)
        } else if let error = link.workspaces?.error {
            Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red).font(.footnote)
        } else if link.status.isOnline, !link.canWrite {
            Label("只读模式：电脑端未允许远程写入，无法新建会话", systemImage: "lock.fill")
                .font(.footnote).foregroundStyle(.secondary)
        }
        let recents = link.workspaces?.recentProjects() ?? []
        if !recents.isEmpty {
            Section {
                RecentStrip(items: recents, sessions: live) { item in
                    launching = LaunchTarget(computerId: link.id, workspace: item.workspace, project: item.project)
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            } header: {
                SectionLabel(title: "最近启动", systemImage: "clock")
            }
        }
        ForEach(workspaces) { workspace in workspaceSection(link, workspace, live: live) }
        let emptyCount = (link.workspaces?.workspaces ?? []).count - workspaces.count
        if emptyCount > 0 {
            Section {} footer: {
                Text("另有 \(emptyCount) 个空工作空间未显示；在电脑端添加项目后出现在这里。")
            }
        }
    }

    private func workspaceSection(_ link: ComputerLink, _ workspace: Workspace, live: [String: [MirrorCard]]) -> some View {
        let id = key(link.id, workspace.id)
        let isOpen = expanded.contains(id)
        return Section {
            if isOpen {
                ForEach(workspace.projects) { project in projectRow(link, workspace, project, live: live) }
            }
        } header: {
            WorkspaceHeader(workspace: workspace, expanded: isOpen,
                            liveCount: workspace.projects.reduce(0) { $0 + (live[normalizeProjectPath($1.path)]?.count ?? 0) }) {
                withAnimation(.snappy) {
                    if expanded.contains(id) { expanded.remove(id) } else { expanded.insert(id) }
                }
            }
        }
    }

    private func projectRow(_ link: ComputerLink, _ workspace: Workspace, _ project: WorkspaceProject,
                            live: [String: [MirrorCard]]) -> some View {
        let target = LaunchTarget(computerId: link.id, workspace: workspace, project: project)
        return Button {
            launching = target
        } label: {
            ProjectRow(project: project, live: live[normalizeProjectPath(project.path)] ?? [])
        }
        .tint(.primary)
        .overlay(alignment: .trailing) { quickMenu(target, canWrite: link.canWrite) }
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            if link.canWrite {
                Button { quickLaunch(target, .claude) } label: { Label("Claude", systemImage: "sparkles") }
                    .tint(CLIGlyph.tint("claude"))
            }
        }
        .contextMenu { quickItems(target, canWrite: link.canWrite) }
    }

    private func quickMenu(_ target: LaunchTarget, canWrite: Bool) -> some View {
        Menu {
            quickItems(target, canWrite: canWrite)
        } label: {
            Image(systemName: "plus.circle.fill")
                .font(.system(size: 24))
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(canWrite ? Color.accentColor : Color.secondary)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .disabled(!canWrite)
        .accessibilityLabel("快速启动 \(target.project.displayName)")
    }

    @ViewBuilder private func quickItems(_ target: LaunchTarget, canWrite: Bool) -> some View {
        Section("在 \(target.project.displayName) 启动") {
            ForEach(CliTool.allCases) { tool in
                Button(tool.label, systemImage: tool.systemImage) { quickLaunch(target, tool) }
                    .disabled(!canWrite)
            }
        }
        Button("更多选项…", systemImage: "ellipsis.circle") { launching = target }
    }

    private func quickLaunch(_ target: LaunchTarget, _ tool: CliTool) {
        Task {
            guard let mirror = hub.link(target.computerId)?.mirror else { return }
            do {
                let id = try await mirror.launch(project: target.project, workspaceName: target.workspace.name, tool: tool)
                path.append(TerminalRoute(sessionId: id, title: target.project.displayName, computerId: target.computerId))
            } catch APIError.forbidden {
                quickError = "远程只读模式已拦截。可在桌面端开启「允许已登录的远程会话写入」。"
            } catch {
                quickError = error.localizedDescription
            }
        }
    }

    /// 每台电脑首次拿到数据：置顶 / 有活会话 / 最近启动过的工作空间默认展开；都没有则展开前两个。
    private func seedExpansion() {
        for link in hub.links where !seeded.contains(link.id) {
            guard let model = link.workspaces, !model.workspaces.isEmpty else { continue }
            seeded.insert(link.id)
            let list = model.workspaces
            let recentIds = Set(model.recentProjects(limit: 4).map(\.workspace.id))
            let live = sessions(link)
            var open = Set(list.filter { ws in
                ws.isPinned || recentIds.contains(ws.id)
                    || ws.projects.contains { live[normalizeProjectPath($0.path)] != nil }
            }.map(\.id))
            if open.isEmpty { open = Set(list.filter { !$0.projects.isEmpty }.prefix(2).map(\.id)) }
            expanded.formUnion(open.map { key(link.id, $0) })
            // 调试：`-launchSheet <项目名>` 打开该项目的启动 sheet（只打开，不启动）
            if launching == nil, let name = UserDefaults.standard.string(forKey: "launchSheet"),
               let ws = list.first(where: { $0.projects.contains { $0.displayName == name } }),
               let project = ws.projects.first(where: { $0.displayName == name }) {
                launching = LaunchTarget(computerId: link.id, workspace: ws, project: project)
            }
        }
    }

    @ViewBuilder private var emptyState: some View {
        let models = hub.links.compactMap(\.workspaces)
        if models.isEmpty || !models.contains(where: \.loaded) {
            if hub.links.contains(where: { $0.status == .connecting || $0.status.isOnline }) { ProgressView() }
        } else if models.allSatisfy({ $0.workspaces.isEmpty && $0.error == nil }) {
            ContentUnavailableView("桌面端还没有工作空间", systemImage: "folder",
                                   description: Text("在电脑端 CC-Panes 新建工作空间并添加项目"))
        }
    }
}

struct LaunchTarget: Identifiable {
    var computerId: String = ""
    let workspace: Workspace
    let project: WorkspaceProject
    var id: String { computerId + "|" + workspace.id + "/" + project.id }
}

/// 多电脑时的电脑分组头：状态点 + 名称 + 线路 + 项目 / 会话数。
private struct ComputerHeader: View {
    let name: String
    let link: ComputerLink
    let projects: Int
    let live: Int

    var body: some View {
        HStack(spacing: 8) {
            LinkStatusDot(status: link.status)
            Image(systemName: "desktopcomputer")
            Text(name).lineLimit(1)
            if link.status.isOnline, let route = HomeStatus.routeLabel(link.via) {
                Text(route).font(.caption).foregroundStyle(.tertiary)
            }
            Spacer(minLength: 4)
            if live > 0 {
                Text("\(live) 在跑").font(.caption.monospacedDigit()).foregroundStyle(.blue)
            }
            if projects > 0 {
                Text("\(projects) 个项目").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
        }
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(.primary)
        .textCase(nil)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// 工作空间分组头：名称 + 置顶 / 隐藏标记 + 项目数 + 活会话数 + 折叠箭头。
private struct WorkspaceHeader: View {
    let workspace: Workspace
    let expanded: Bool
    let liveCount: Int
    let onToggle: () -> Void

    var body: some View {
        Button(action: onToggle) {
            HStack(spacing: 8) {
                Text(workspace.displayName)
                    .font(.headline)
                    .foregroundStyle(workspace.isHidden ? Color.secondary : Color.primary)
                    .lineLimit(1)
                if workspace.isPinned {
                    Image(systemName: "pin.fill").font(.caption2).foregroundStyle(.orange).accessibilityLabel("已置顶")
                }
                if workspace.isHidden {
                    Image(systemName: "eye.slash").font(.caption2).foregroundStyle(.secondary).accessibilityLabel("已隐藏")
                }
                Spacer(minLength: 6)
                if liveCount > 0 {
                    HStack(spacing: 4) {
                        PhaseDot(phase: .running, size: 6)
                        Text("\(liveCount) 在跑").monospacedDigit()
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.blue)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Color.blue.opacity(0.12), in: Capsule())
                    .accessibilityLabel("\(liveCount) 个会话在跑")
                }
                Text("\(workspace.projects.count) 个项目")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(expanded ? 90 : 0))
            }
            .textCase(nil)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(.isHeader)
        .accessibilityHint(expanded ? "折叠" : "展开")
    }
}

/// 项目行：首字母方块 + 名称 / 路径 + 活会话状态。右侧留给「+」快速启动按钮。
private struct ProjectRow: View {
    let project: WorkspaceProject
    let live: [MirrorCard]

    var body: some View {
        HStack(spacing: 12) {
            ProjectMonogram(name: project.displayName)
            VStack(alignment: .leading, spacing: 2) {
                Text(project.displayName).font(.body.weight(.medium)).lineLimit(1)
                Text(abbreviatePath(project.path)).font(.caption).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: 6)
            if let top = live.map(\.phase).max() {
                HStack(spacing: 4) {
                    PhaseDot(phase: top, size: 7)
                    Text(live.count > 1 ? "\(live.count)" : top.label).monospacedDigit()
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(top.color)
                .accessibilityLabel("\(live.count) 个会话，\(top.label)")
            }
            Color.clear.frame(width: 36, height: 1) // 「+」按钮占位
        }
        .padding(.vertical, 2)
    }
}

/// 项目首字母方块：颜色由名称稳定散列。
struct ProjectMonogram: View {
    let name: String
    var size: CGFloat = 34

    var body: some View {
        Text(String(name.first.map { String($0).uppercased() } ?? "?"))
            .font(.system(size: size * 0.44, weight: .bold, design: .rounded))
            .foregroundStyle(color)
            .frame(width: size, height: size)
            .background(color.opacity(0.15), in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
            .accessibilityHidden(true)
    }

    private var color: Color {
        let palette: [Color] = [.blue, .purple, .pink, .orange, .teal, .indigo, .green, .cyan, .mint, .brown]
        let hash = name.unicodeScalars.reduce(UInt32(5381)) { ($0 &* 33) &+ $1.value }
        return palette[Int(hash % UInt32(palette.count))]
    }
}

/// 最近启动：横滑卡（项目 + CLI + 时间 + 最后一句 prompt），点按打开启动 sheet。
private struct RecentStrip: View {
    let items: [RecentProject]
    let sessions: [String: [MirrorCard]]
    let onSelect: (RecentProject) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(items) { item in
                    Button { onSelect(item) } label: { card(item) }
                        .buttonStyle(PressableCardStyle())
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 2)
        }
    }

    private func card(_ item: RecentProject) -> some View {
        let live = sessions[normalizeProjectPath(item.project.path)] ?? []
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                ProjectMonogram(name: item.project.displayName, size: 28)
                Spacer(minLength: 0)
                if let top = live.map(\.phase).max() { PhaseCapsule(phase: top, text: live.count > 1 ? "\(live.count)" : nil) }
            }
            Text(item.project.displayName).font(.subheadline.weight(.semibold)).lineLimit(1)
            Text(subtitle(item)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
        .padding(12)
        .frame(width: 150, alignment: .leading)
        .background(DK.card, in: RoundedRectangle(cornerRadius: DK.cardRadius, style: .continuous))
    }

    private func subtitle(_ item: RecentProject) -> String {
        let ago = shortRelative(item.launchedAt) ?? ""
        let ws = item.workspace.displayName == item.project.displayName ? "" : item.workspace.displayName
        return [ws, cliDisplayName(item.record.cliTool ?? ""), ago].filter { !$0.isEmpty }.joined(separator: " · ")
    }
}
