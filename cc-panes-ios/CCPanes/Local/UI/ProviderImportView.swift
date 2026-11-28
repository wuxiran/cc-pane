import SwiftUI

/// 从电脑导入供应商（docs/112 §6）：电脑端「设置 → 供应商 → 导出到手机」生成 6 位导出码，
/// 这里选一台已配对的电脑、输码，经设备令牌连接领取（含密钥），密钥直接写进 Keychain。
struct ProviderImportView: View {
    let targets: [ProviderImportTarget]
    var env = LocalEnvironment.shared
    @State private var targetId: String
    @State private var code: String
    @State private var busy = false
    @State private var error: String?
    @State private var summary: LocalProviderStore.ImportSummary?
    @FocusState private var focused: Bool

    init(targets: [ProviderImportTarget], env: LocalEnvironment = .shared) {
        self.targets = targets
        self.env = env
        _targetId = State(initialValue: targets.first?.id ?? "")
        #if DEBUG
        _code = State(initialValue: UserDefaults.standard.string(forKey: "localImportCode") ?? "")
        #else
        _code = State(initialValue: "")
        #endif
    }

    private var target: ProviderImportTarget? { targets.first { $0.id == targetId } }

    var body: some View {
        Form {
            if targets.isEmpty {
                Section {
                    Label("没有在线且已配对的电脑。导出密钥只对用配对码配对过的连接开放（直连 / 网页登录不行）。",
                          systemImage: "key.slash")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            } else {
                Section {
                    if targets.count > 1 {
                        Picker("电脑", selection: $targetId) {
                            ForEach(targets) { Text($0.name).tag($0.id) }
                        }
                    } else if let target {
                        LabeledContent("电脑", value: target.name)
                    }
                    TextField("6 位导出码", text: $code)
                        .keyboardType(.numberPad)
                        .font(.title2.monospacedDigit())
                        .focused($focused)
                        .onChange(of: code) { _, value in code = String(value.filter(\.isNumber).prefix(6)) }
                } header: {
                    Text("导出码")
                } footer: {
                    Text("在电脑上打开「设置 → 供应商 → 导出到手机」，勾选要带到手机的供应商并生成导出码（5 分钟内有效、只能用一次）。")
                }
                Section {
                    Button {
                        Task { await redeem() }
                    } label: {
                        HStack {
                            Text("导入")
                            if busy { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(busy || code.count != 6 || target == nil)
                }
            }
            if let error {
                Section { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red).font(.footnote) }
            }
            if let summary { resultSection(summary) }
        }
        .navigationTitle("从电脑导入")
        .navigationBarTitleDisplayMode(.inline)
        // 电脑连上前 targets 可能为空：到达后补选第一台
        .onChange(of: targets.map(\.id), initial: true) { _, ids in
            if !ids.contains(targetId) { targetId = ids.first ?? "" }
        }
        .task(id: targetId) {
            #if DEBUG
            if code.count == 6, target != nil, summary == nil, !busy { await redeem() }
            #endif
        }
    }

    @ViewBuilder private func resultSection(_ summary: LocalProviderStore.ImportSummary) -> some View {
        Section("导入结果") {
            ForEach(summary.added, id: \.self) { Label("\($0)（新增）", systemImage: "checkmark.circle.fill").foregroundStyle(.green) }
            ForEach(summary.updated, id: \.self) { Label("\($0)（已更新）", systemImage: "arrow.triangle.2.circlepath").foregroundStyle(.blue) }
            ForEach(summary.skipped, id: \.name) { item in
                VStack(alignment: .leading, spacing: 2) {
                    Label(item.name, systemImage: "minus.circle").foregroundStyle(.secondary)
                    Text(item.reason).font(.caption).foregroundStyle(.secondary)
                }
            }
            if summary.added.isEmpty && summary.updated.isEmpty {
                Text("没有可在手机直连的供应商").foregroundStyle(.secondary)
            }
        }
    }

    private func redeem() async {
        guard let target else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let payload = try await ProviderExportClient.redeem(target: target, code: code)
            summary = try env.providers.importPayload(payload, computerName: target.name)
            code = ""
            focused = false
        } catch {
            self.error = error.localizedDescription
        }
    }
}
