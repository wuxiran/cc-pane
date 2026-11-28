import SwiftUI

/// 电脑面板（右上角电脑按钮）：全部电脑的实时状态 / 线路 / 保持连接开关，配对新电脑，进入设置。
struct ComputersSheet: View {
    let hub: ConnectionHub
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var path: [ComputersRoute]
    @State private var pairing = false
    @State private var detent: PresentationDetent

    init(hub: ConnectionHub, initialPage: ComputerSheetPage) {
        self.hub = hub
        _path = State(initialValue: initialPage == .settings ? [.settings] : initialPage == .localModels ? [.localModels] : [])
        _detent = State(initialValue: initialPage == .computers ? .medium : .large)
    }

    var body: some View {
        NavigationStack(path: $path) {
            Form {
                Section {
                    ForEach(model.computers) { computer in row(computer) }
                    Button { pairing = true } label: { Label("配对新电脑", systemImage: "plus.circle") }
                } header: {
                    Text("电脑")
                } footer: {
                    Text("开着「保持连接」的电脑同时在线，对话 / 终端 / 工作区汇总显示。点进去可改名、管理地址、重新配对。")
                }
                Section {
                    NavigationLink(value: ComputersRoute.localModels) {
                        LabeledContent {
                            Text(localSummary)
                        } label: {
                            Label("本机模型", systemImage: "iphone.gen3")
                        }
                    }
                } header: {
                    Text("本机 iPhone")
                } footer: {
                    Text("手机直连模型 API 的对话不经过电脑。供应商可从已配对的电脑导入，或手动添加。")
                }
                Section {
                    NavigationLink(value: ComputersRoute.settings) { Label("设置", systemImage: "gearshape") }
                }
            }
            .navigationTitle("电脑")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
            .navigationDestination(for: ComputersRoute.self) { route in
                switch route {
                case .settings: SettingsView(hub: hub)
                case .localModels:
                    LocalProvidersView(targets: hub.importTargets,
                                       startImport: UserDefaults.standard.string(forKey: "localImportCode") != nil)
                case .computer(let id): ComputerDetailView(computerId: id, hub: hub)
                }
            }
            .refreshable { await hub.refreshAll() }
        }
        .presentationDetents([.medium, .large], selection: $detent)
        .onChange(of: path) { _, path in if !path.isEmpty { detent = .large } }
        .sheet(isPresented: $pairing) { PairSheet() }
    }

    private var localSummary: String {
        let env = LocalEnvironment.shared
        let count = env.providers.providers.count
        return count == 0 ? "未设置" : "\(count) 个供应商"
    }

    private func row(_ computer: Computer) -> some View {
        let link = hub.link(computer.id)
        return HStack(spacing: 12) {
            Button {
                path.append(.computer(computer.id))
            } label: {
                ComputerStatusRow(name: hub.name(computer.id), computer: computer, link: link)
            }
            .buttonStyle(.borderless)
            .tint(.primary)
            Toggle("保持连接", isOn: Binding(
                get: { computer.isEnabled },
                set: { model.setKeepConnected(computer.id, $0) }))
                .labelsHidden()
                .accessibilityLabel("保持连接 \(hub.name(computer.id))")
        }
        .swipeActions {
            Button("删除", role: .destructive) { model.remove(computer.id) }
        }
    }
}

enum ComputersRoute: Hashable {
    case settings
    case localModels
    case computer(String)
}

/// 电脑行：状态点 + 名称 + 「线路 · 状态 · host:port」。
struct ComputerStatusRow: View {
    let name: String
    let computer: Computer
    let link: ComputerLink?

    var body: some View {
        HStack(spacing: 12) {
            LinkStatusDot(status: computer.isEnabled ? link?.status : nil)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(name).lineLimit(1)
                    if computer.isPaired {
                        Image(systemName: "key.fill").font(.caption2).foregroundStyle(.secondary)
                            .accessibilityLabel("已配对")
                    }
                }
                Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
    }

    private var subtitle: String {
        let address = ComputerNaming.hostPort(link?.api?.baseURL.absoluteString ?? ComputerNaming.primaryAddress(computer)) ?? "-"
        guard computer.isEnabled else { return "已暂停 · " + address }
        guard let link else { return address }
        var parts: [String] = []
        if link.status.isOnline {
            if let route = HomeStatus.routeLabel(link.via) { parts.append(route) }
            if link.chatsUnsupported { parts.append("版本较旧") }
            if link.hostDown { parts.append("CC-Panes 未运行") }
        } else {
            parts.append(link.status.label)
        }
        parts.append(address)
        return parts.joined(separator: " · ")
    }
}

struct LinkStatusDot: View {
    let status: ComputerLink.Status?

    var body: some View {
        Group {
            if status == .connecting {
                ProgressView().controlSize(.mini)
            } else {
                Circle().fill(color)
            }
        }
        .frame(width: 10, height: 10)
        .accessibilityLabel(status?.label ?? "已暂停")
    }

    private var color: Color {
        switch status {
        case .online: .green
        case .offline, .failed: .red
        case .unauthorized, .needsLogin: .orange
        default: .gray
        }
    }
}

/// 设置：外观 + 版本。电脑相关全在电脑面板。
struct SettingsView: View {
    var hub: ConnectionHub?
    @AppStorage(AppAppearance.key) private var appearance = AppAppearance.dark.rawValue

    var body: some View {
        Form {
            Section("外观") {
                Picker("主题", selection: $appearance) {
                    ForEach(AppAppearance.allCases) { Text($0.label).tag($0.rawValue) }
                }
            }
            Section("本机模型") {
                NavigationLink {
                    LocalProvidersView(targets: hub?.importTargets ?? [])
                } label: {
                    Label("本机模型（Provider）", systemImage: "iphone.gen3")
                }
            }
            Section {
                LabeledContent("版本", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "-")
            }
        }
        .navigationTitle("设置")
    }
}

/// 一台电脑的行：在线点 + 名称 + 地址摘要 + 当前标记。
struct ComputerRow: View {
    let computer: Computer
    let reachability: AppModel.Reachability
    let isCurrent: Bool

    var body: some View {
        HStack(spacing: 12) {
            ReachabilityDot(reachability: reachability)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(computer.name).lineLimit(1)
                    if computer.isPaired {
                        Image(systemName: "key.fill").font(.caption2).foregroundStyle(.secondary)
                            .accessibilityLabel("已配对")
                    }
                }
                Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
            if isCurrent {
                Image(systemName: "checkmark").foregroundStyle(Color.accentColor).accessibilityLabel("当前电脑")
            }
        }
    }

    private var subtitle: String {
        let first = AddressBook.ordered(computer.addresses).first.flatMap { URL(string: $0)?.host() } ?? "-"
        let extra = computer.addresses.count > 1 ? " 等 \(computer.addresses.count) 个地址" : ""
        guard let seen = computer.lastSeen else { return first + extra }
        return first + extra + " · " + seen.formatted(.relative(presentation: .named).locale(Locale(identifier: "zh_CN")))
    }
}

struct ReachabilityDot: View {
    let reachability: AppModel.Reachability

    var body: some View {
        Group {
            if reachability == .checking {
                ProgressView().controlSize(.mini)
            } else {
                Circle().fill(color)
            }
        }
        .frame(width: 10, height: 10)
        .accessibilityLabel(label)
    }

    private var color: Color {
        switch reachability {
        case .online: .green
        case .offline: .red
        default: .gray
        }
    }

    private var label: String {
        switch reachability {
        case .online: "在线"
        case .offline: "离线"
        case .checking: "检测中"
        case .unknown: "未知"
        }
    }
}

/// 单台电脑：改名、地址增删、重新配对、删除。
struct ComputerDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let computerId: String
    let hub: ConnectionHub
    @State private var name = ""
    @State private var newAddress = ""
    @State private var addError: String?
    @State private var repair = false
    @State private var confirmDelete = false

    var body: some View {
        if let computer = model.computers.first(where: { $0.id == computerId }) {
            Form {
                Section("名称") {
                    TextField(hub.name(computerId), text: $name)
                        .onSubmit { model.rename(computerId, to: name) }
                }
                connectionSection(computer)
                Section {
                    ForEach(AddressBook.ordered(computer.addresses), id: \.self) { address in
                        LabeledContent(address) { Text(AddressBook.kind(of: address).label) }
                            .deleteDisabled(computer.addresses.count <= 1)
                    }
                    .onDelete { offsets in
                        let ordered = AddressBook.ordered(computer.addresses)
                        offsets.map { ordered[$0] }.forEach { model.removeAddress(computerId, $0) }
                    }
                    HStack {
                        TextField("如 http://100.101.102.103:18080", text: $newAddress)
                            .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        Button("添加") {
                            addError = model.addAddress(computerId, newAddress) ? nil : "地址无效或已存在"
                            if addError == nil { newAddress = "" }
                        }
                        .disabled(newAddress.isEmpty)
                    }
                    if let addError { Text(addError).font(.caption).foregroundStyle(.red) }
                } header: {
                    Text("地址")
                } footer: {
                    Text("连接时并发探测全部地址：局域网优先（领跑 0.5 秒），Tailscale 等兜底。")
                }
                Section {
                    Toggle("保持连接", isOn: Binding(get: { computer.isEnabled },
                                                   set: { model.setKeepConnected(computerId, $0) }))
                    if computer.isEnabled {
                        Button("重新连接") { Task { await hub.reconnect(computerId) } }
                    }
                    Button(computer.isPaired ? "重新配对" : "用配对码配对") { repair = true }
                    Button("删除这台电脑", role: .destructive) { confirmDelete = true }
                } footer: {
                    if computer.isPaired { Text("删除会同时移除钥匙串中的设备令牌。电脑端可在「其他设备」里吊销。") }
                }
            }
            .navigationTitle(hub.name(computerId))
            .onAppear { name = ComputerNaming.isAutoName(computer) ? "" : computer.name }
            .onDisappear { if !name.isEmpty { model.rename(computerId, to: name) } }
            .sheet(isPresented: $repair) {
                PairSheet(initialAddress: computer.lastAddress ?? AddressBook.ordered(computer.addresses).first ?? "")
            }
            .confirmationDialog("删除「\(computer.name)」？", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("删除", role: .destructive) {
                    model.remove(computerId)
                    dismiss()
                }
            }
        } else {
            ContentUnavailableView("电脑已删除", systemImage: "desktopcomputer.trianglebadge.exclamationmark")
        }
    }
}

extension ComputerDetailView {
    /// 连接信息（原设置页「当前连接」，现在每台电脑各一份）。
    @ViewBuilder func connectionSection(_ computer: Computer) -> some View {
        let link = hub.link(computerId)
        Section("连接") {
            LabeledContent("状态", value: computer.isEnabled ? (link?.status.label ?? "-") : "已暂停")
            if let link, link.status.isOnline {
                LabeledContent("线路", value: HomeStatus.routeLabel(link.via) ?? "-")
                LabeledContent("地址", value: link.api?.baseURL.absoluteString ?? "-")
                LabeledContent("鉴权", value: link.api?.token != nil ? "设备令牌" : (link.auth?.username ?? "-"))
                LabeledContent("写权限", value: link.canWrite ? "允许" : "只读")
                if let info = link.info {
                    if let host = info.hostname { LabeledContent("机器名", value: host) }
                    if let version = info.appVersion {
                        LabeledContent("CC-Panes", value: version + (ComputerNaming.isDev(info) ? "（开发版）" : ""))
                    }
                }
                if link.chatsUnsupported {
                    Label("这台电脑的 CC-Panes 版本较旧：没有对话 / Bot，终端与工作区可用", systemImage: "arrow.up.circle")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
    }
}

/// 设置页里的配对弹窗（复用连接页的 PairForm）。
struct PairSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var initialAddress = ""
    @State private var address = ""
    @State private var code = ""

    var body: some View {
        NavigationStack {
            Form {
                PairForm(address: $address, code: $code)
                if let message = model.pairError {
                    Section { Text(message).foregroundStyle(.red) }
                }
            }
            .navigationTitle("配对电脑")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } } }
            .onAppear { address = initialAddress }
            .onChange(of: model.pairingBusy) { was, busy in
                if was, !busy, model.pairError == nil { dismiss() }
            }
        }
    }
}
