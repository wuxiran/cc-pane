import SwiftUI

/// 输入区：圆角输入卡（多行输入 + 发送 / 停止），下方一排配置胶囊（模式 / 模型 / 其它 select 配置）。
struct ChatComposer: View {
    let session: AcpChatSession
    @Binding var draft: String
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if session.readOnly {
                Label("远程只读：可查看对话，不能发送或审批", systemImage: "lock")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 4)
            }
            VStack(alignment: .leading, spacing: 6) {
                TextField(placeholder, text: $draft, axis: .vertical)
                    .font(.callout)
                    .lineLimit(1...6)
                    .focused($focused)
                    .disabled(session.readOnly)
                    .padding(.horizontal, 4)
                    .padding(.top, 4)
                HStack(alignment: .center, spacing: 6) {
                    chips
                    Spacer(minLength: 0)
                    actionButton
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(DK.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(focused ? Color.accentColor.opacity(0.5) : Color.primary.opacity(0.08))
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }

    private var placeholder: String {
        switch session.state.phase {
        case .starting: "agent 启动中…"
        case .exited, .failed: "会话已结束"
        default: "给 agent 发消息"
        }
    }

    @ViewBuilder private var actionButton: some View {
        if session.isGenerating {
            Button {
                Task { await session.cancelTurn() }
            } label: {
                Image(systemName: "stop.fill")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 32, height: 32)
                    .background(Color.red, in: Circle())
            }
            .disabled(session.readOnly)
            .accessibilityLabel("停止本轮")
        } else {
            let enabled = session.canSend && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            Button {
                let text = draft
                draft = ""
                Task { await session.send(text) }
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(enabled ? Color.white : Color.secondary)
                    .frame(width: 32, height: 32)
                    .background(enabled ? Color.accentColor : DK.inset, in: Circle())
            }
            .disabled(!enabled)
            .accessibilityLabel("发送")
        }
    }

    /// 模式 / 模型 / 配置项各一个胶囊菜单；横向可滚，避免窄屏溢出。
    @ViewBuilder private var chips: some View {
        let snapshot = session.state.snapshot
        let modes = snapshot?.modes ?? []
        let models = snapshot?.models ?? []
        let configs = snapshot?.configOptions ?? []
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                if !modes.isEmpty {
                    chip(symbol: "dial.medium", choices: modes, current: snapshot?.currentModeId, title: "模式") { id in
                        Task { await session.setMode(id) }
                    }
                }
                if !models.isEmpty {
                    chip(symbol: "cpu", choices: models, current: snapshot?.currentModelId, title: "模型") { id in
                        Task { await session.setModel(id) }
                    }
                }
                ForEach(configs) { option in
                    chip(symbol: "slider.horizontal.3", choices: option.choices, current: option.currentValue,
                         title: option.name) { value in
                        Task { await session.setConfigOption(option.configId, value: value) }
                    }
                }
            }
        }
        // 不能 scrollClipDisabled：配置项多时（claude 4 个）胶囊会画到发送按钮下面、溢出输入卡。
        .mask(LinearGradient(stops: [.init(color: .black, location: 0.9), .init(color: .clear, location: 1)],
                             startPoint: .leading, endPoint: .trailing))
        .disabled(session.readOnly || session.state.phase.isTerminal)
    }

    private func chip(symbol: String, choices: [AcpChoice], current: String?, title: String,
                      apply: @escaping (String) -> Void) -> some View {
        Menu {
            Picker(title, selection: Binding(get: { current ?? "" }, set: { if $0 != current { apply($0) } })) {
                ForEach(choices) { Text($0.name).tag($0.id) }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: symbol).imageScale(.small)
                Text(choices.first { $0.id == current }?.name ?? title).lineLimit(1)
                    .frame(maxWidth: 120)
                Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold))
            }
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 9)
            .padding(.vertical, 6)
            .background(DK.inset, in: Capsule())
        }
        .tint(.primary)
        .accessibilityLabel("\(title)：\(choices.first { $0.id == current }?.name ?? "未选择")")
    }
}
