import SwiftUI

/// 输入区：多行输入 + 发送 / 停止；快照广告模式、模型时显示切换菜单。
struct ChatComposer: View {
    let session: AcpChatSession
    @Binding var draft: String
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 6) {
            if session.readOnly {
                Label("远程只读：可查看对话，不能发送或审批", systemImage: "lock")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack(alignment: .bottom, spacing: 8) {
                menus
                TextField(placeholder, text: $draft, axis: .vertical)
                    .lineLimit(1...6)
                    .focused($focused)
                    .disabled(session.readOnly)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(.secondary.opacity(0.15), in: RoundedRectangle(cornerRadius: 18))
                actionButton
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
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
                Image(systemName: "stop.circle.fill").font(.system(size: 30))
            }
            .tint(.red)
            .disabled(session.readOnly)
            .accessibilityLabel("停止本轮")
        } else {
            Button {
                let text = draft
                draft = ""
                Task { await session.send(text) }
            } label: {
                Image(systemName: "arrow.up.circle.fill").font(.system(size: 30))
            }
            .disabled(!session.canSend || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel("发送")
        }
    }

    @ViewBuilder private var menus: some View {
        let snapshot = session.state.snapshot
        let modes = snapshot?.modes ?? []
        let models = snapshot?.models ?? []
        let configs = snapshot?.configOptions ?? []
        if !modes.isEmpty || !models.isEmpty || !configs.isEmpty {
            Menu {
                if !modes.isEmpty {
                    Picker("模式", selection: selection(snapshot?.currentModeId) { id in Task { await session.setMode(id) } }) {
                        ForEach(modes) { Text($0.name).tag($0.id) }
                    }
                    .pickerStyle(.inline)
                }
                if !models.isEmpty {
                    Picker("模型", selection: selection(snapshot?.currentModelId) { id in Task { await session.setModel(id) } }) {
                        ForEach(models) { Text($0.name).tag($0.id) }
                    }
                    .pickerStyle(.menu)
                }
                ForEach(configs) { option in
                    Picker(option.name, selection: selection(option.currentValue) { value in
                        Task { await session.setConfigOption(option.configId, value: value) }
                    }) {
                        ForEach(option.choices) { Text($0.name).tag($0.id) }
                    }
                    .pickerStyle(.menu)
                }
            } label: {
                Image(systemName: "slider.horizontal.3")
                    .font(.system(size: 20))
                    .frame(width: 32, height: 36)
            }
            .disabled(session.readOnly)
            .accessibilityLabel("模式、模型与配置")
        }
    }

    private func selection(_ current: String?, apply: @escaping (String) -> Void) -> Binding<String> {
        Binding(get: { current ?? "" }, set: { if $0 != current { apply($0) } })
    }
}
