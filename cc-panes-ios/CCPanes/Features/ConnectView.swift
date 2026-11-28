import SwiftUI

/// 连接页：已保存的电脑（点按连接）+ 「配对码」/「直连」两种添加方式。
struct ConnectView: View {
    enum Mode: String, CaseIterable, Identifiable {
        case pair = "配对码", direct = "直连"
        var id: String { rawValue }
    }

    @Environment(AppModel.self) private var model
    @State private var mode: Mode
    @State private var pairAddress = ""
    @State private var pairCode = ""
    @State private var username = "admin"
    @State private var password = ""

    init() {
        // 调试：`-connectMode direct|pair`；默认「配对码」。
        let raw = UserDefaults.standard.string(forKey: "connectMode")
        _mode = State(initialValue: Mode.allCases.first { "\($0)" == raw } ?? .pair)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section { BrandHeader() }
                    .listRowBackground(Color.clear)
                if !model.computers.isEmpty { savedSection }
                Section {
                    Picker("方式", selection: $mode) {
                        ForEach(Mode.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
                switch mode {
                case .pair: PairForm(address: $pairAddress, code: $pairCode)
                case .direct: directSection
                }
                statusSection
                Section {
                    Button {
                        model.localOnly = true
                    } label: {
                        Label("先在本机使用（直连模型 API，不连电脑）", systemImage: "iphone.gen3")
                    }
                } footer: {
                    Text("在「电脑 → 本机模型」里填 API Key 或从电脑导入后，就能在手机上直接对话。")
                }
            }
            .toolbar(.hidden, for: .navigationBar) // 品牌头已含标题
            .frame(maxWidth: 560)
            .task { await model.refreshReachability() }
            .onChange(of: model.state) { _, state in
                if state == .tokenRejected { prefillRepair() }
            }
        }
    }

    private var savedSection: some View {
        Section("已保存的电脑") {
            ForEach(model.computers) { computer in
                Button {
                    Task { await model.switchTo(computer.id) }
                } label: {
                    ComputerRow(computer: computer, reachability: model.reachability[computer.id] ?? .unknown,
                                isCurrent: computer.id == model.currentId)
                }
                .tint(.primary)
                .disabled(model.state == .connecting)
            }
        }
    }

    @ViewBuilder private var directSection: some View {
        @Bindable var model = model
        Section {
            TextField("http://192.168.1.10:18080", text: $model.serverURL)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .onSubmit { Task { await model.connectDirect() } }
            Button {
                Task { await model.connectDirect() }
            } label: {
                HStack {
                    Text("连接")
                    Spacer()
                    if model.state == .connecting { ProgressView() }
                }
            }
            .disabled(model.state == .connecting)
        } header: {
            Text("电脑地址")
        } footer: {
            Text("用账号密码登录（或电脑端未设密码时免登录）。局域网访问需在电脑端开启「允许局域网访问」；模拟器可直接用 127.0.0.1。")
        }
        if model.state == .needsLogin {
            Section("登录") {
                TextField("用户名", text: $username)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("密码", text: $password)
                Button("登录") { Task { await model.login(username: username, password: password) } }
                    .disabled(password.isEmpty)
            }
        }
    }

    @ViewBuilder private var statusSection: some View {
        switch model.state {
        case .tokenRejected:
            Section {
                Label("令牌失效，请重新配对", systemImage: "key.slash").foregroundStyle(.red)
            } footer: {
                Text("在电脑端「设置 → Web 访问 → 其他设备」生成新的配对码，填入上方后重新配对。")
            }
        case .failed(let message):
            Section { Text(message).foregroundStyle(.red) }
        default:
            EmptyView()
        }
    }

    private func prefillRepair() {
        mode = .pair
        pairCode = ""
        if let current = model.current {
            pairAddress = current.lastAddress ?? AddressBook.ordered(current.addresses).first ?? ""
        }
    }
}

/// 配对码表单：地址 + 6 位码 → POST /api/device/pair。
struct PairForm: View {
    @Environment(AppModel.self) private var model
    @Binding var address: String
    @Binding var code: String

    var body: some View {
        Section {
            TextField("http://192.168.1.10:18080", text: $address)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            TextField("6 位配对码", text: $code)
                .keyboardType(.numberPad)
                .font(.title3.monospacedDigit())
                .onChange(of: code) { _, value in
                    let digits = String(value.filter(\.isNumber).prefix(6))
                    if digits != value { code = digits }
                }
            Button {
                Task { await model.pair(address: address, code: code) }
            } label: {
                HStack {
                    Text("配对并连接")
                    Spacer()
                    if model.pairingBusy { ProgressView() }
                }
            }
            .disabled(model.pairingBusy || model.state == .connecting || DevicePairing.normalizeCode(code) == nil || address.isEmpty)
        } header: {
            Text("配对新电脑")
        } footer: {
            Text("在电脑端打开「设置 → Web 访问 → 其他设备 → 允许其他设备连接」，生成 6 位配对码（5 分钟内有效）。令牌只保存在本机钥匙串。")
        }
    }
}

struct BrandHeader: View {
    var body: some View {
        VStack(spacing: 10) {
            Image("Logo")
                .resizable()
                .scaledToFit()
                .frame(width: 88, height: 88)
                .clipShape(RoundedRectangle(cornerRadius: 88 * 0.22, style: .continuous))
                .accessibilityHidden(true)
            Text("CC-Panes").font(.title2.bold())
            Text("连接电脑上的 CC-Panes").font(.subheadline).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 4)
    }
}
