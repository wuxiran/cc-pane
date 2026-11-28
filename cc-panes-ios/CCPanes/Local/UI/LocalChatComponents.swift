import SwiftUI

/// 「本机」芯片：本机对话在合并列表里的归属标注（与 ComputerChip 同形，图标为 iPhone）。
struct LocalChip: View {
    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "iphone").imageScale(.small)
            Text("本机")
        }
        .font(.caption2.weight(.medium))
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .foregroundStyle(Color.accentColor)
        .background(Color.accentColor.opacity(0.12), in: Capsule())
        .fixedSize()
    }
}

/// 本机对话的列表行（与 ChatSummaryRow 同版式）。
struct LocalChatRow: View {
    let item: LocalChatListItem

    var body: some View {
        HStack(spacing: 12) {
            LocalChatIcon()
                .overlay(alignment: .bottomTrailing) {
                    Circle().fill(item.isGenerating ? Color.blue : item.hasError ? Color.red : Color.green)
                        .frame(width: 10, height: 10)
                        .overlay(Circle().strokeBorder(DK.card, lineWidth: 2))
                        .offset(x: 3, y: 3)
                }
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(item.title).font(.body.weight(.semibold)).lineLimit(1)
                    Spacer(minLength: 4)
                    if let ago = shortRelative(item.updatedAt) {
                        Text(ago).font(.caption).foregroundStyle(.secondary).fixedSize()
                    }
                }
                HStack(spacing: 5) {
                    LocalChip()
                    Text("\(item.providerName) · \(item.modelId)").lineLimit(1)
                    Spacer(minLength: 4)
                    if item.isGenerating {
                        Text("生成中").font(.caption.weight(.semibold)).foregroundStyle(.blue)
                    } else if item.hasError {
                        Text("失败").font(.caption.weight(.semibold)).foregroundStyle(.red)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

struct LocalChatIcon: View {
    var size: CGFloat = 40

    var body: some View {
        Image(systemName: "iphone.gen3")
            .font(.system(size: size * 0.45, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(LinearGradient(colors: [.indigo, .blue], startPoint: .topLeading, endPoint: .bottomTrailing),
                        in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
    }
}

/// 新建对话 sheet 里「本机 iPhone」那一段：选供应商 + 模型（可手填模型 id）。
struct LocalNewChatSection: View {
    let env: LocalEnvironment
    @Binding var providerId: String
    @Binding var modelId: String
    var onManage: () -> Void

    private var usable: [LocalProvider] { env.providers.providers.filter { env.providers.hasKey($0.id) } }
    private var provider: LocalProvider? { usable.first { $0.id == providerId } }

    var body: some View {
        if usable.isEmpty {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text("还没有本机模型").font(.subheadline.weight(.semibold))
                    Text("从电脑导入供应商（含 API Key），或手动填写，之后就能在手机上直接对话。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Button("设置本机模型…", systemImage: "key.horizontal", action: onManage)
            } header: {
                Text("本机模型")
            }
        } else {
            Section {
                Picker("供应商", selection: $providerId) {
                    ForEach(usable) { provider in Text(provider.name).tag(provider.id) }
                }
                if let provider, !provider.models.isEmpty {
                    Picker("模型", selection: $modelId) {
                        ForEach(provider.models) { Text($0.displayName).tag($0.id) }
                        if !provider.models.contains(where: { $0.id == modelId }), !modelId.isEmpty {
                            Text(modelId).tag(modelId)
                        }
                    }
                }
                TextField("模型 id", text: $modelId)
                    .font(.callout.monospaced())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("管理本机模型…", systemImage: "slider.horizontal.3", action: onManage)
            } header: {
                Text("本机模型")
            } footer: {
                Text("直连供应商 API，不需要电脑在线；暂不支持工具调用与文件操作。")
            }
            .onChange(of: providerId) { _, id in
                if let provider = usable.first(where: { $0.id == id }) { modelId = provider.preferredModelId ?? "" }
            }
        }
    }
}

extension ConnectionHub {
    /// 可导入供应商的电脑：在线且有设备令牌（配对过）的连接。
    var importTargets: [ProviderImportTarget] {
        links.compactMap { link in
            guard link.status.isOnline, let api = link.api else { return nil }
            return ProviderImportTarget(id: link.id, name: name(link.id), api: api)
        }
    }
}
