import SwiftUI

/// 设置：「电脑」地址簿（添加 / 改名 / 删除 / 切换 / 在线状态）+ 当前连接信息。
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var pairing = false

    var body: some View {
        Form {
            Section {
                ForEach(model.computers) { computer in
                    NavigationLink {
                        ComputerDetailView(computerId: computer.id)
                    } label: {
                        ComputerRow(computer: computer, reachability: model.reachability[computer.id] ?? .unknown,
                                    isCurrent: computer.id == model.currentId)
                    }
                    .swipeActions {
                        Button("删除", role: .destructive) { model.remove(computer.id) }
                        if computer.id != model.currentId {
                            Button("切换") { Task { await model.switchTo(computer.id) } }.tint(.blue)
                        }
                    }
                }
                Button {
                    pairing = true
                } label: {
                    Label("配对新电脑", systemImage: "plus.circle")
                }
            } header: {
                Text("电脑")
            } footer: {
                Text("左滑可切换或删除；点进去可改名、管理地址（局域网 / Tailscale）。")
            }
            Section("当前连接") {
                LabeledContent("地址", value: model.api?.baseURL.absoluteString ?? "-")
                LabeledContent("鉴权", value: model.api?.token != nil ? "设备令牌" : (model.auth?.username ?? "-"))
                LabeledContent("写权限", value: model.canWrite ? "允许" : "只读")
            }
            Section {
                Button("断开连接", role: .destructive) { model.disconnect() }
            }
            Section {
                LabeledContent("版本", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "-")
            }
        }
        .navigationTitle("设置")
        .task { await model.refreshReachability() }
        .refreshable { await model.refreshReachability() }
        .sheet(isPresented: $pairing) { PairSheet() }
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
    @State private var name = ""
    @State private var newAddress = ""
    @State private var addError: String?
    @State private var repair = false
    @State private var confirmDelete = false

    var body: some View {
        if let computer = model.computers.first(where: { $0.id == computerId }) {
            Form {
                Section("名称") {
                    TextField("电脑名称", text: $name)
                        .onSubmit { model.rename(computerId, to: name) }
                }
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
                    if computer.id != model.currentId {
                        Button("切换到这台电脑") { Task { await model.switchTo(computerId) } }
                    }
                    Button(computer.isPaired ? "重新配对" : "用配对码配对") { repair = true }
                    Button("删除这台电脑", role: .destructive) { confirmDelete = true }
                } footer: {
                    if computer.isPaired { Text("删除会同时移除钥匙串中的设备令牌。电脑端可在「其他设备」里吊销。") }
                }
            }
            .navigationTitle(computer.name)
            .onAppear { name = computer.name }
            .onDisappear { model.rename(computerId, to: name) }
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
        }
    }
}
