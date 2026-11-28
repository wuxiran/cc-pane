import SwiftUI

/// Bot 详情：所在电脑、引擎、工作目录、远程权限（§5.3 四级；`full` 红色警示 + 二次确认）。
struct BotDetailView: View {
    let contactId: String
    let model: ContactsModel
    let onMessage: () -> Void
    @State private var pendingFull = false
    @State private var saving: String?
    @State private var error: String?

    init(contactId: String, model: ContactsModel, onMessage: @escaping () -> Void) {
        self.contactId = contactId
        self.model = model
        self.onMessage = onMessage
        #if DEBUG
        // 调试：`-contactConfirmFull YES` 进详情即弹「完全信任」确认（截图核对警示文案）
        _pendingFull = State(initialValue: UserDefaults.standard.bool(forKey: "contactConfirmFull"))
        #endif
    }

    var body: some View {
        if let contact = model.contact(contactId) {
            content(contact)
        } else {
            ContentUnavailableView("找不到这个 Bot", systemImage: "person.crop.circle.badge.questionmark")
        }
    }

    private func content(_ contact: BotContact) -> some View {
        let node = model.node(contact.nodeId)
        let online = model.isOnline(contact)
        let presence = BotPresence(contact: contact, nodeOnline: online)
        return List {
            Section {
                VStack(spacing: 10) {
                    BotAvatar(contact: contact, size: 76, presence: presence)
                    Text(contact.name).font(.title2.weight(.bold))
                    if let persona = contact.personaSummary {
                        Text(persona).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    }
                    HStack(spacing: 6) {
                        PhaseCapsule(phase: presence.phase, text: presence.label)
                        PolicyBadge(policy: contact.remotePolicy, compact: false)
                    }
                    Button(action: onMessage) {
                        Label("发消息", systemImage: "bubble.left.fill").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(!online)
                    .padding(.top, 4)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
                .listRowBackground(Color.clear)
            }

            Section {
                if contact.remotePolicy.isDangerous { FullPolicyWarning() }
                ForEach(RemotePolicy.levels, id: \.self) { level in
                    policyRow(level, contact: contact)
                }
                if contact.remotePolicy == .allowlist { allowKindsRow(contact) }
            } header: {
                Text("远程权限")
            } footer: {
                Text(policyFooter)
            }
            Section("信息") {
                LabeledContent("所在电脑") {
                    HStack(spacing: 6) {
                        Circle().fill(online ? Color.green : Color.gray).frame(width: 8, height: 8)
                        Text(node?.name ?? "-")
                        if node?.isCurrent == true { Text("当前").foregroundStyle(Color.accentColor) }
                    }
                }
                if let via = model.directories[contact.nodeId]?.via, online {
                    LabeledContent("线路", value: via.label)
                }
                LabeledContent("引擎") {
                    HStack(spacing: 6) {
                        CLIGlyph(tool: contact.engineId, size: 22)
                        Text(AcpEngineStyle.label(contact.engineId))
                    }
                }
                // SharedBot 不含 cwd（§5.2）；旧 / 扩展字段带了才显示。
                if let cwd = contact.cwd {
                    LabeledContent("工作目录") {
                        Text(abbreviatePath(cwd))
                            .font(.callout.monospaced())
                            .lineLimit(2)
                            .truncationMode(.middle)
                            .textSelection(.enabled)
                    }
                }
                LabeledContent("Bot ID") {
                    Text(contact.botId).font(.callout.monospaced()).textSelection(.enabled)
                }
            }

        }
        .listStyle(.insetGrouped)
        .readableContentWidth()
        .navigationTitle(contact.name)
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("开启「完全信任」？", isPresented: $pendingFull, titleVisibility: .visible) {
            Button("开启完全信任", role: .destructive) {
                Task { await save(BotRemoteChange(policy: .full, confirmFull: true), contact: contact) }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("已配对设备发来的消息将在「\(node?.name ?? "这台电脑")」上全部自动放行——读写文件、执行命令都不再询问。只对你信任的设备开启。")
        }
        #if DEBUG
        .task { await debugApply(contact) }
        #endif
        .alert("修改失败", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("好") {}
        } message: {
            Text(error ?? "")
        }
    }

    private var policyFooter: String {
        let base = "只作用于由其他设备消息开启的回合，不影响在电脑上手动发起的对话。要停止共享这个 Bot，请在电脑端「联系人 → 远程权限」关闭共享。"
        return model.service.canEditPolicy ? base : base + "\n请在该电脑 CC-Panes 的 Bot 设置里修改。"
    }

    private func policyRow(_ level: RemotePolicy, contact: BotContact) -> some View {
        let selected = contact.remotePolicy == level
        return Button {
            guard !selected else { return }
            if level.isDangerous {
                pendingFull = true
            } else {
                Task { await save(BotRemoteChange(policy: level), contact: contact) }
            }
        } label: {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: level.symbol)
                    .foregroundStyle(PolicyBadge.tint(level))
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 3) {
                    Text(level.label)
                        .font(.body.weight(selected ? .semibold : .regular))
                        .foregroundStyle(level.isDangerous ? Color.red : Color.primary)
                    Text(level.detail).font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
                if saving == level.raw {
                    ProgressView()
                } else if selected {
                    Image(systemName: "checkmark").foregroundStyle(Color.accentColor).fontWeight(.semibold)
                }
            }
            .contentShape(Rectangle())
        }
        .tint(.primary)
        .disabled(!model.service.canEditPolicy || saving != nil)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    #if DEBUG
    /// 联调：`-contactSetPolicy <deny|ask_origin|allowlist|full>` 进详情后走与点按相同的路径改策略
    /// （full 先弹红色确认 2 秒再执行「开启完全信任」按钮的动作）；`-contactSetKinds read,search` 改白名单。
    private func debugApply(_ contact: BotContact) async {
        let defaults = UserDefaults.standard
        if let raw = defaults.string(forKey: "contactSetPolicy") {
            let policy = RemotePolicy(raw: raw)
            if policy.isDangerous {
                pendingFull = true
                try? await Task.sleep(for: .seconds(2))
                pendingFull = false
                await save(BotRemoteChange(policy: .full, confirmFull: true), contact: contact)
            } else {
                await save(BotRemoteChange(policy: policy), contact: contact)
            }
        }
        if let raw = defaults.string(forKey: "contactSetKinds"), let latest = model.contact(contact.id) {
            let kinds = raw.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }
            await save(BotRemoteChange(allowKinds: kinds), contact: latest, marker: "kinds")
        }
    }
    #endif

    /// allowlist：可勾选的工具类型（勾一个即 PATCH 一次 `remoteAllowKinds`）。
    private func allowKindsRow(_ contact: BotContact) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("自动放行的工具类型").font(.subheadline.weight(.semibold))
            FlowChips(items: RemotePolicy.allowKinds.map(\.id)) { kind in
                let on = contact.remoteAllowKinds.contains(kind)
                Button {
                    var kinds = contact.remoteAllowKinds.filter { $0 != kind }
                    if !on { kinds.append(kind) }
                    Task { await save(BotRemoteChange(allowKinds: kinds), contact: contact, marker: "kinds") }
                } label: {
                    Label(RemotePolicy.kindLabel(kind), systemImage: on ? "checkmark.circle.fill" : "circle")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .foregroundStyle(on ? Color.white : Color.primary)
                        .background(on ? Color.blue : DK.inset, in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(!model.service.canEditPolicy || saving != nil)
            }
            if contact.remoteAllowKinds.isEmpty {
                Text("还没勾选：等同逐条审批").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }

    private func save(_ change: BotRemoteChange, contact: BotContact, marker: String? = nil) async {
        saving = marker ?? change.policy?.raw
        defer { saving = nil }
        do {
            try await model.update(change, for: contact)
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// `full` 常驻红色警示。
struct FullPolicyWarning: View {
    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text("最高权限已开启").font(.subheadline.weight(.semibold))
                Text("其他设备触发的回合会自动执行任何工具，包括写文件与运行命令。").font(.caption)
            }
        } icon: {
            Image(systemName: "exclamationmark.shield.fill")
        }
        .foregroundStyle(.red)
        .listRowBackground(Color.red.opacity(0.12))
    }
}

/// 远程策略徽标。行内（compact）只显示需要注意的两档：`full`（红）与 `deny`（灰）。
struct PolicyBadge: View {
    let policy: RemotePolicy
    let compact: Bool

    var body: some View {
        if !compact || policy.isDangerous || policy == .deny {
            HStack(spacing: 3) {
                Image(systemName: policy.symbol).imageScale(.small)
                if !compact || policy.isDangerous { Text(policy.label) }
            }
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .foregroundStyle(Self.tint(policy))
            .background(Self.tint(policy).opacity(0.14), in: Capsule())
            .fixedSize()
            .accessibilityLabel("远程权限：\(policy.label)")
        }
    }

    static func tint(_ policy: RemotePolicy) -> Color {
        switch policy {
        case .full: .red
        case .allowlist: .blue
        case .askOrigin: .green
        case .deny, .unknown: .secondary
        }
    }
}

/// Bot 头像：emoji 或名字首字，底色取 Bot 的 `color`（无则按 id 稳定取色），右下角在线点。
struct BotAvatar: View {
    let contact: BotContact
    var size: CGFloat = 44
    var presence: BotPresence?

    var body: some View {
        Text(contact.avatarText)
            .font(.system(size: size * (contact.avatarIsEmoji ? 0.5 : 0.42), weight: .semibold, design: .rounded))
            .foregroundStyle(contact.avatarIsEmoji ? Color.primary : tint)
            .frame(width: size, height: size)
            .background(tint.opacity(0.18), in: Circle())
            .overlay(alignment: .bottomTrailing) {
                if let presence {
                    PhaseDot(phase: presence.phase, size: max(9, size * 0.22))
                        .padding(2)
                        .background(DK.card, in: Circle())
                        .offset(x: 2, y: 2)
                }
            }
            .accessibilityHidden(true)
    }

    private var tint: Color {
        if let css = contact.color, let color = Color(css: css) { return color }
        let palette: [Color] = [.orange, .teal, .indigo, .pink, .blue, .purple, .mint, .brown]
        let hash = contact.botId.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xFFFF }
        return palette[hash % palette.count]
    }
}

extension Color {
    /// `#rgb` / `#rrggbb`（Bot 头像底色）；其他 CSS 写法返回 nil。
    init?(css: String) {
        var hex = css.trimmingCharacters(in: .whitespaces)
        guard hex.hasPrefix("#") else { return nil }
        hex.removeFirst()
        if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
        guard hex.count == 6, let value = UInt32(hex, radix: 16) else { return nil }
        self.init(red: Double((value >> 16) & 0xFF) / 255, green: Double((value >> 8) & 0xFF) / 255,
                  blue: Double(value & 0xFF) / 255)
    }
}

// MARK: - 对话

/// Bot 对话：先拿到连向 Bot 所在电脑的 AcpService（其他电脑要探测地址），再复用 ChatScreen。
struct BotChatContainer: View {
    let contact: BotContact
    let model: ContactsModel
    let canWrite: Bool
    let onShowDetail: () -> Void
    @State private var service: (any AcpService)?
    @State private var failed = false

    var body: some View {
        Group {
            if let service {
                ChatScreen(route: ChatRoute(chatId: contact.chatId, title: contact.name, engineId: contact.engineId),
                           service: service, canWrite: canWrite)
            } else if failed {
                ContentUnavailableView("连不上这台电脑", systemImage: "wifi.slash",
                                       description: Text("「\(model.node(contact.nodeId)?.name ?? "")」当前不可达，稍后再试"))
                    .toolbar(.hidden, for: .tabBar)
            } else {
                ProgressView("正在连接 \(model.node(contact.nodeId)?.name ?? "电脑")…")
                    .toolbar(.hidden, for: .tabBar)
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Bot 详情", systemImage: "person.crop.circle", action: onShowDetail)
            }
        }
        .task {
            guard service == nil else { return }
            service = await model.chatService(for: contact)
            failed = service == nil
        }
    }
}

/// 自动换行的胶囊行（allowlist 类型勾选）。
struct FlowChips<Content: View>: View {
    let items: [String]
    @ViewBuilder let content: (String) -> Content

    var body: some View {
        FlowLayout(spacing: 8) {
            ForEach(items, id: \.self) { content($0) }
        }
    }
}

struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(0, rows.count - 1))
        let width = rows.map(\.width).max() ?? 0
        return CGSize(width: proposal.width ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row { var indices: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0 }

    private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = [Row()]
        for (i, subview) in subviews.enumerated() {
            let size = subview.sizeThatFits(.unspecified)
            let needed = rows[rows.count - 1].indices.isEmpty ? size.width : rows[rows.count - 1].width + spacing + size.width
            if needed > width, !rows[rows.count - 1].indices.isEmpty {
                rows.append(Row())
            }
            var row = rows[rows.count - 1]
            row.width = row.indices.isEmpty ? size.width : row.width + spacing + size.width
            row.height = max(row.height, size.height)
            row.indices.append(i)
            rows[rows.count - 1] = row
        }
        return rows.filter { !$0.indices.isEmpty }
    }
}
