import SwiftUI

/// 通讯录导航目标（id = `BotContact.id`，即 `电脑id/botId`）。
enum ContactRoute: Hashable {
    case chat(String)
    case detail(String)
}

/// 「通讯录」tab：地址簿里所有电脑上的 Bot（docs/112 §5.5），按电脑分组，当前电脑在前。
/// 点按 = 与 Bot 对话（连到 Bot 所在电脑）；长按 / 左滑 = 详情（所在电脑、工作目录、远程权限）。
struct ContactsTabView: View {
    let hub: ConnectionHub
    @Environment(HomeRouter.self) private var router
    @State private var path: [ContactRoute]
    /// 顶部搜索框已并入统一搜索 tab；保留空查询以复用分组逻辑。
    private let query = ""

    private var model: ContactsModel { hub.contacts }

    init(hub: ConnectionHub) {
        self.hub = hub
        // 调试：`-openContact <电脑id/botId>` 直接进对话，`-contactDetail <电脑id/botId>` 直接进详情
        let defaults = UserDefaults.standard
        var initial: [ContactRoute] = []
        if let id = defaults.string(forKey: "contactDetail") { initial = [.detail(id)] }
        if let id = defaults.string(forKey: "openContact") { initial = [.chat(id)] }
        _path = State(initialValue: initial)
    }

    var body: some View {
        NavigationStack(path: $path) {
            list
                .overlay { emptyState }
                .refreshable { await reload() }
                .navigationTitle("通讯录")
                .homeTabChrome()
                .navigationDestination(for: ContactRoute.self) { route in destination(route) }
        }
        .onChange(of: path) { old, new in markPoppedChatsSeen(old: old, new: new) }
        .onChange(of: router.pending, initial: true) { _, _ in
            guard case .contact(let id, let detail)? = router.take(for: .contacts) else { return }
            path = [detail ? .detail(id) : .chat(id)]
        }
    }

    private func reload() async {
        await hub.refreshAll()
    }

    @ViewBuilder private func destination(_ route: ContactRoute) -> some View {
        switch route {
        case .chat(let id):
            if let contact = model.contact(id) {
                BotChatContainer(contact: contact, model: model, canWrite: canWrite(contact)) {
                    path.append(.detail(id))
                }
            } else {
                loadingOrMissing
            }
        case .detail(let id):
            if let contact = model.contact(id) {
                BotDetailView(contactId: id, model: model) { path.append(.chat(contact.id)) }
            } else {
                loadingOrMissing
            }
        }
    }

    @ViewBuilder private var loadingOrMissing: some View {
        if model.loaded {
            ContentUnavailableView("找不到这个 Bot", systemImage: "person.crop.circle.badge.questionmark",
                                   description: Text("它可能已被删除，或所在电脑已离线"))
        } else {
            ProgressView()
        }
    }

    /// 沿用该电脑连接的读写权限；不在 hub 里（mock）视同主人（被拒时对话页自行切只读）。
    private func canWrite(_ contact: BotContact) -> Bool {
        hub.link(contact.nodeId)?.canWrite ?? true
    }

    /// 从对话返回：刷新一轮后把该 Bot 记为已读（含刚才自己这轮产生的事件）。
    private func markPoppedChatsSeen(old: [ContactRoute], new: [ContactRoute]) {
        let popped = old.compactMap { route -> String? in
            if case .chat(let id) = route, !new.contains(route) { return id }
            return nil
        }
        guard !popped.isEmpty else { return }
        Task {
            await reload()
            for id in popped { if let contact = model.contact(id) { model.markSeen(contact) } }
        }
    }

    private var list: some View {
        List {
            ForEach(model.sections(query: query)) { section in
                Section {
                    if let message = section.directory.status.message {
                        NodeStatusRow(status: section.directory.status, lastSeen: section.node.lastSeen, message: message)
                    } else if section.contacts.isEmpty, section.directory.status.isOnline {
                        Text("这台电脑还没有 Bot，可在电脑端「联系人」里创建")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(section.contacts) { contact in row(contact, online: section.directory.status.isOnline) }
                } header: {
                    NodeSectionHeader(node: section.node, directory: section.directory)
                }
            }
        }
        .listStyle(.insetGrouped)
        .listSectionSpacing(14)
        .readableContentWidth()
        .animation(.snappy, value: model.sections(query: query))
    }

    private func row(_ contact: BotContact, online: Bool) -> some View {
        Button {
            model.markSeen(contact)
            path.append(.chat(contact.id))
        } label: {
            ContactRow(contact: contact, online: online, unread: model.isUnread(contact))
        }
        .tint(.primary)
        .disabled(!online)
        .swipeActions(edge: .trailing) {
            Button("详情", systemImage: "info.circle") { path.append(.detail(contact.id)) }
                .tint(.gray)
        }
        .contextMenu {
            Button("发消息", systemImage: "bubble.left") { path.append(.chat(contact.id)) }
                .disabled(!online)
            Button("查看详情", systemImage: "info.circle") { path.append(.detail(contact.id)) }
        } preview: {
            BotPreviewCard(contact: contact, node: model.node(contact.nodeId), online: online)
        }
    }

    @ViewBuilder private var emptyState: some View {
        if !model.loaded, model.totalBots == 0 {
            ProgressView()
        } else if model.nodes.isEmpty {
            ContentUnavailableView {
                Label("还没有电脑", systemImage: "desktopcomputer")
            } description: {
                Text("点右上角电脑按钮配对后，这里会列出每台电脑上的 Bot")
            }
        } else if !query.isEmpty, model.sections(query: query).isEmpty {
            ContentUnavailableView.search(text: query)
        }
    }
}

// MARK: - Rows

struct ContactRow: View {
    let contact: BotContact
    let online: Bool
    let unread: Bool

    private var presence: BotPresence { BotPresence(contact: contact, nodeOnline: online) }

    var body: some View {
        HStack(spacing: 12) {
            BotAvatar(contact: contact, size: 44, presence: presence)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(contact.name).font(.body.weight(.semibold)).lineLimit(1)
                    PolicyBadge(policy: contact.remotePolicy, compact: true)
                    Spacer(minLength: 4)
                    trailing
                }
                HStack(spacing: 5) {
                    Image(systemName: CLIGlyph.symbol(contact.engineId))
                        .foregroundStyle(CLIGlyph.tint(contact.engineId))
                        .imageScale(.small)
                    Text(subtitle).lineLimit(1)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .opacity(online ? 1 : 0.55)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(contact.name)，\(presence.label)")
    }

    @ViewBuilder private var trailing: some View {
        if contact.pendingPermissions > 0 {
            Text("\(contact.pendingPermissions) 待审批")
                .font(.caption2.weight(.bold))
                .foregroundStyle(.white)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(.orange, in: Capsule())
                .fixedSize()
        } else if presence == .busy {
            Text("工作中").font(.caption.weight(.semibold)).foregroundStyle(.blue).fixedSize()
        } else if unread {
            Circle().fill(Color.accentColor).frame(width: 9, height: 9).accessibilityLabel("有新消息")
        } else if let ago = shortRelative(dateFromMillis(contact.updatedAt)) {
            Text(ago).font(.caption).foregroundStyle(.secondary).fixedSize()
        }
    }

    private var subtitle: String {
        var parts = [AcpEngineStyle.label(contact.engineId)]
        if let persona = contact.personaSummary, !persona.isEmpty { parts.append(persona) }
        else if presence != .online { parts.append(presence.label) }
        return parts.joined(separator: " · ")
    }
}

/// 分组头：在线点 + 电脑名 + 「当前」+ 线路（局域网 / Tailscale）+ Bot 数。
struct NodeSectionHeader: View {
    let node: ContactNode
    let directory: NodeDirectory

    var body: some View {
        HStack(spacing: 6) {
            Group {
                if directory.status == .loading {
                    ProgressView().controlSize(.mini)
                } else {
                    Circle().fill(dotColor)
                }
            }
            .frame(width: 8, height: 8)
            Image(systemName: "desktopcomputer").imageScale(.small)
            Text(node.name).lineLimit(1)
            if node.isCurrent {
                Text("当前")
                    .font(.caption2.weight(.bold))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .foregroundStyle(Color.accentColor)
                    .background(Color.accentColor.opacity(0.14), in: Capsule())
            }
            if let via = directory.via, directory.status.isOnline {
                Text(via.label).foregroundStyle(.tertiary)
            }
            Spacer(minLength: 0)
            if directory.status.isOnline { Text("\(directory.bots.count)").monospacedDigit() }
        }
        .font(.footnote.weight(.semibold))
        .foregroundStyle(.secondary)
        .textCase(nil)
        .accessibilityElement(children: .combine)
    }

    private var dotColor: Color {
        switch directory.status {
        case .online: .green
        case .hostUnavailable, .tokenRejected: .orange
        default: .gray
        }
    }
}

/// 电脑不可用时组内的一行说明（离线 / 令牌失效 / 未运行 / 版本过旧）。
struct NodeStatusRow: View {
    let status: NodeStatus
    let lastSeen: Date?
    let message: String

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(message)
                if status == .offline, let lastSeen {
                    Text("上次在线 " + lastSeen.formatted(.relative(presentation: .named).locale(Locale(identifier: "zh_CN"))))
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
        } icon: {
            Image(systemName: symbol).foregroundStyle(tint)
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
    }

    private var symbol: String {
        switch status {
        case .offline: "wifi.slash"
        case .tokenRejected: "key.slash"
        case .hostUnavailable: "desktopcomputer.trianglebadge.exclamationmark"
        case .unsupported: "arrow.up.circle"
        default: "exclamationmark.triangle"
        }
    }

    private var tint: Color {
        switch status {
        case .tokenRejected, .hostUnavailable: .orange
        case .error: .red
        default: .secondary
        }
    }
}

/// 长按预览卡。
struct BotPreviewCard: View {
    let contact: BotContact
    let node: ContactNode?
    let online: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                BotAvatar(contact: contact, size: 52, presence: BotPresence(contact: contact, nodeOnline: online))
                VStack(alignment: .leading, spacing: 4) {
                    Text(contact.name).font(.headline)
                    Text(node?.name ?? "").font(.caption).foregroundStyle(.secondary)
                }
            }
            if let persona = contact.personaSummary { Text(persona).font(.subheadline) }
            HStack(spacing: 6) {
                PhaseCapsule(phase: BotPresence(contact: contact, nodeOnline: online).phase,
                             text: BotPresence(contact: contact, nodeOnline: online).label)
                PolicyBadge(policy: contact.remotePolicy, compact: false)
            }
        }
        .padding(16)
        .frame(width: 300, alignment: .leading)
    }
}
