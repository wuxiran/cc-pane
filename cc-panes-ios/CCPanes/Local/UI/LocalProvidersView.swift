import SwiftUI

/// 「本机模型」：手机直连用的供应商列表（名称 / 协议 / 地址 / 密钥状态），从电脑导入或手动添加。
/// 密钥只在 Keychain；列表只显示「已存钥匙串」。
struct LocalProvidersView: View {
    /// 可导入的电脑（在线且已配对）。
    var targets: [ProviderImportTarget] = []
    var env = LocalEnvironment.shared
    @State private var editing: LocalProvider?
    @State private var adding = false
    @State private var importing: Bool

    init(targets: [ProviderImportTarget] = [], env: LocalEnvironment = .shared, startImport: Bool = false) {
        self.targets = targets
        self.env = env
        _importing = State(initialValue: startImport)
    }

    var body: some View {
        Form {
            Section {
                if env.providers.providers.isEmpty {
                    Text("还没有本机模型。从电脑导入，或手动填写 API Key。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                ForEach(env.providers.providers) { provider in
                    Button { editing = provider } label: { LocalProviderRow(provider: provider, hasKey: env.providers.hasKey(provider.id)) }
                        .tint(.primary)
                        .swipeActions {
                            Button("删除", role: .destructive) { env.providers.delete(provider.id) }
                        }
                }
            } header: {
                Text("供应商")
            } footer: {
                Text("在「对话 → 新建 → 本机 iPhone」里使用。请求从这台 iPhone 直连供应商，不经过电脑；API Key 只保存在本机钥匙串（不随备份迁移）。")
            }
            Section {
                Button { importing = true } label: { Label("从电脑导入", systemImage: "square.and.arrow.down.on.square") }
                Button { adding = true } label: { Label("手动添加", systemImage: "plus.circle") }
            }
        }
        .navigationTitle("本机模型")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(isPresented: $importing) {
            ProviderImportView(targets: targets, env: env)
        }
        .sheet(isPresented: $adding) {
            NavigationStack { LocalProviderEditor(provider: nil, env: env) }
        }
        .sheet(item: $editing) { provider in
            NavigationStack { LocalProviderEditor(provider: provider, env: env) }
        }
    }
}

struct LocalProviderRow: View {
    let provider: LocalProvider
    let hasKey: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: provider.kind == .anthropic ? "a.circle.fill" : "o.circle.fill")
                .font(.title2)
                .foregroundStyle(provider.kind == .anthropic ? Color.orange : Color.teal)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(provider.name).lineLimit(1)
                    if let source = provider.sourceComputer {
                        ComputerChip(name: source)
                    }
                }
                Text("\(provider.kind.shortLabel) · \(URL(string: provider.baseURL)?.host() ?? provider.baseURL) · \(provider.models.count) 个模型")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
            Image(systemName: hasKey ? "key.fill" : "key.slash")
                .font(.caption)
                .foregroundStyle(hasKey ? Color.green : Color.orange)
                .accessibilityLabel(hasKey ? "密钥已存钥匙串" : "没有密钥")
        }
    }
}

/// 新增 / 编辑一个本机供应商。密钥框留空 = 不改（编辑时）。
struct LocalProviderEditor: View {
    let original: LocalProvider?
    let env: LocalEnvironment
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var kind: LLMProtocol
    @State private var baseURL: String
    @State private var apiKey = ""
    @State private var modelsText: String
    @State private var defaultModel: String
    @State private var fetching = false
    @State private var error: String?

    init(provider: LocalProvider?, env: LocalEnvironment = .shared) {
        original = provider
        self.env = env
        _name = State(initialValue: provider?.name ?? "")
        _kind = State(initialValue: provider?.kind ?? .anthropic)
        _baseURL = State(initialValue: provider?.baseURL ?? LLMProtocol.anthropic.defaultBaseURL)
        _modelsText = State(initialValue: provider?.models.map(\.id).joined(separator: "\n") ?? "claude-opus-5-5")
        _defaultModel = State(initialValue: provider?.defaultModelId ?? provider?.models.first?.id ?? "claude-opus-5-5")
    }

    private var models: [String] {
        modelsText.split(whereSeparator: { $0.isNewline || $0 == "," })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    private var hasKey: Bool { original.map { env.providers.hasKey($0.id) } ?? false }

    var body: some View {
        Form {
            Section("名称") {
                TextField("如：我的中转站", text: $name)
            }
            Section {
                Picker("协议", selection: $kind) {
                    ForEach(LLMProtocol.allCases) { Text($0.label).tag($0) }
                }
                TextField("Base URL", text: $baseURL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } header: {
                Text("接口")
            } footer: {
                Text(kind == .anthropic
                     ? "填根地址（如 https://api.anthropic.com 或中转站地址），会请求 /v1/messages。"
                     : "填到 /v1 级（如 https://api.openai.com/v1），会请求 /chat/completions。")
            }
            Section {
                SecureField(hasKey ? "已存钥匙串（留空不改）" : "粘贴 API Key", text: $apiKey)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } header: {
                Text("API Key")
            } footer: {
                Text("只保存在本机钥匙串，不写入文件、不随备份迁移。")
            }
            Section {
                TextField("每行一个模型 id", text: $modelsText, axis: .vertical)
                    .font(.callout.monospaced())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .lineLimit(2...8)
                if !models.isEmpty {
                    Picker("默认模型", selection: $defaultModel) {
                        ForEach(models, id: \.self) { Text($0).tag($0) }
                    }
                }
                Button {
                    Task { await fetchModels() }
                } label: {
                    HStack {
                        Label("从服务端拉取模型列表", systemImage: "arrow.down.circle")
                        if fetching { Spacer(); ProgressView() }
                    }
                }
                .disabled(fetching || (apiKey.isEmpty && !hasKey))
            } header: {
                Text("模型")
            }
            if let error {
                Text(error).font(.footnote).foregroundStyle(.red)
            }
        }
        .navigationTitle(original == nil ? "添加本机模型" : "编辑")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: kind) { old, new in
            if baseURL.isEmpty || baseURL == old.defaultBaseURL { baseURL = new.defaultBaseURL }
        }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button("保存") { save() }.disabled(!canSave)
            }
        }
    }

    private var canSave: Bool {
        !name.trimmingCharacters(in: .whitespaces).isEmpty && !models.isEmpty
            && (try? LLMClient.endpoint(kind: kind, baseURL: baseURL)) != nil
            && (hasKey || !apiKey.trimmingCharacters(in: .whitespaces).isEmpty)
    }

    private func save() {
        var provider = original ?? LocalProvider(name: name, kind: kind, baseURL: baseURL)
        provider.name = name
        provider.kind = kind
        provider.baseURL = baseURL
        let labels = Dictionary(uniqueKeysWithValues: (original?.models ?? []).map { ($0.id, $0.label) })
        provider.models = models.map { LocalModel(id: $0, label: labels[$0] ?? nil) }
        provider.defaultModelId = models.contains(defaultModel) ? defaultModel : models.first
        do {
            try env.providers.save(provider, apiKey: apiKey.isEmpty ? nil : apiKey)
            dismiss()
        } catch {
            self.error = "保存失败：\(error.localizedDescription)"
        }
    }

    private func fetchModels() async {
        let key = apiKey.isEmpty ? original.flatMap { env.providers.apiKey(for: $0.id) } : apiKey
        guard let key else { return }
        fetching = true
        defer { fetching = false }
        do {
            let list = try await env.chats.client.listModels(kind: kind, baseURL: baseURL, apiKey: key)
            guard !list.isEmpty else { error = "服务端没有返回模型"; return }
            modelsText = list.map(\.id).joined(separator: "\n")
            if !list.contains(where: { $0.id == defaultModel }) { defaultModel = list[0].id }
            error = nil
        } catch {
            self.error = "拉取失败：\(error.localizedDescription)"
        }
    }
}
