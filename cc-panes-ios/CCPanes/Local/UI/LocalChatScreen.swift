import SwiftUI

/// 本机对话页：复用远程对话的气泡 / Markdown / 思考折叠，底部输入框 + 发送 / 停止，
/// 标题栏菜单切换模型、改名、删除。每条回复下显示模型与 token 用量（服务端有回报时）。
struct LocalChatScreen: View {
    let chatId: String
    var env = LocalEnvironment.shared
    var onDeleted: () -> Void = {}
    @State private var draft = ""
    @State private var renaming = false
    @State private var newTitle = ""
    @State private var confirmDelete = false
    @FocusState private var focused: Bool

    private var store: LocalChatStore { env.chats }
    private var chat: LocalChat? { store.chat(chatId) }
    private var generating: Bool { store.isGenerating(chatId) }

    var body: some View {
        Group {
            if let chat {
                transcript(chat)
                    .safeAreaInset(edge: .bottom, spacing: 0) { composer(chat) }
            } else {
                ContentUnavailableView("对话已删除", systemImage: "trash")
            }
        }
        .background(DK.canvas)
        .navigationTitle(chat?.title ?? "本机对话")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .principal) { titleView }
            ToolbarItem(placement: .topBarTrailing) { menu }
        }
        .alert("重命名", isPresented: $renaming) {
            TextField("标题", text: $newTitle)
            Button("取消", role: .cancel) {}
            Button("保存") { store.rename(chatId, to: newTitle) }
        }
        .confirmationDialog("删除这条本机对话？", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("删除", role: .destructive) {
                store.delete(chatId)
                onDeleted()
            }
        }
        #if DEBUG
        .task { autoSend() }
        #endif
    }

    private var titleView: some View {
        VStack(spacing: 1) {
            Text(chat?.title ?? "本机对话").font(.headline).lineLimit(1)
            HStack(spacing: 4) {
                Image(systemName: "iphone").imageScale(.small)
                Text(subtitle).lineLimit(1)
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
    }

    private var subtitle: String {
        guard let chat else { return LocalChatListItem.computerName }
        let provider = env.providers.provider(chat.providerId)?.name ?? "供应商已删除"
        return "\(provider) · \(chat.modelId)"
    }

    private var menu: some View {
        Menu {
            if let chat {
                Menu("切换模型", systemImage: "cpu") {
                    ForEach(env.providers.providers) { provider in
                        Section(provider.name) {
                            ForEach(provider.models) { model in
                                Button {
                                    store.setModel(chatId, providerId: provider.id, modelId: model.id)
                                } label: {
                                    if chat.providerId == provider.id && chat.modelId == model.id {
                                        Label(model.displayName, systemImage: "checkmark")
                                    } else {
                                        Text(model.displayName)
                                    }
                                }
                            }
                        }
                    }
                }
                .disabled(generating)
                Button("重命名", systemImage: "pencil") {
                    newTitle = chat.title
                    renaming = true
                }
                let usage = chat.totalUsage
                if !usage.isEmpty {
                    Text("累计 ↑\(usage.inputTokens ?? 0) ↓\(usage.outputTokens ?? 0) tokens")
                }
                Button("删除对话", systemImage: "trash", role: .destructive) { confirmDelete = true }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("对话选项")
    }

    private func transcript(_ chat: LocalChat) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if chat.messages.isEmpty {
                        emptyHint.padding(.top, 60)
                    }
                    ForEach(chat.messages) { message in
                        row(message, isLast: message.id == chat.messages.last?.id).id(message.id)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .onChange(of: chat.messages.last?.text) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
            .onChange(of: chat.messages.count) { _, _ in
                withAnimation(.snappy) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
        }
    }

    private var emptyHint: some View {
        VStack(spacing: 8) {
            Image(systemName: "iphone.gen3").font(.largeTitle).foregroundStyle(.secondary)
            Text("在手机上直接对话").font(.headline)
            Text("请求从这台 iPhone 直连供应商 API，不需要电脑在线。暂不支持工具调用与文件操作。")
                .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
    }

    @ViewBuilder private func row(_ message: LocalMessage, isLast: Bool) -> some View {
        switch message.role {
        case .user:
            UserBubble(text: message.text)
        case .assistant:
            VStack(alignment: .leading, spacing: 8) {
                if let thinking = message.thinking, !thinking.isEmpty {
                    ThoughtRow(text: thinking, done: !(isLast && generating) || !message.text.isEmpty)
                }
                if !message.text.isEmpty {
                    MarkdownView(text: message.text).frame(maxWidth: .infinity, alignment: .leading)
                } else if isLast && generating && (message.thinking ?? "").isEmpty {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small)
                        Text("等待回复…").font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if let error = message.error {
                    errorRow(error, isLast: isLast)
                } else if message.cancelled == true {
                    HStack(spacing: 8) {
                        NoticeRow(text: "已停止", systemImage: "stop.circle")
                        if isLast { retryButton }
                    }
                }
                footer(message)
            }
        }
    }

    private func errorRow(_ error: String, isLast: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(error, systemImage: "exclamationmark.triangle.fill")
                .font(.footnote)
                .foregroundStyle(.red)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            if isLast { retryButton }
        }
    }

    private var retryButton: some View {
        Button("重试", systemImage: "arrow.clockwise") { store.retry(chatId) }
            .font(.footnote.weight(.semibold))
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(generating)
    }

    @ViewBuilder private func footer(_ message: LocalMessage) -> some View {
        let parts = footerParts(message)
        if !parts.isEmpty {
            Text(parts.joined(separator: " · "))
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.tertiary)
        }
    }

    private func footerParts(_ message: LocalMessage) -> [String] {
        var parts: [String] = []
        if let model = message.model { parts.append(model) }
        if let usage = message.usage {
            if let input = usage.inputTokens { parts.append("↑\(input)") }
            if let output = usage.outputTokens { parts.append("↓\(output)") }
        }
        if message.stopReason == "max_tokens" || message.stopReason == "length" { parts.append("已达长度上限") }
        return parts
    }

    private func composer(_ chat: LocalChat) -> some View {
        let missingKey = !env.providers.hasKey(chat.providerId)
        return VStack(alignment: .leading, spacing: 6) {
            if missingKey {
                Label("这个供应商没有 API Key，去「电脑 → 本机模型」补上", systemImage: "key.slash")
                    .font(.caption).foregroundStyle(.orange).padding(.horizontal, 4)
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("给 \(chat.modelId) 发消息", text: $draft, axis: .vertical)
                    .font(.callout)
                    .lineLimit(1...6)
                    .focused($focused)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 6)
                actionButton
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(DK.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(focused ? Color.accentColor.opacity(0.5) : Color.primary.opacity(0.08))
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .background(.bar)
    }

    @ViewBuilder private var actionButton: some View {
        if generating {
            Button { store.cancel(chatId) } label: {
                Image(systemName: "stop.fill")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 32, height: 32)
                    .background(Color.red, in: Circle())
            }
            .accessibilityLabel("停止生成")
        } else {
            Button { send() } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 32, height: 32)
                    .background(canSend ? Color.accentColor : Color.gray.opacity(0.4), in: Circle())
            }
            .disabled(!canSend)
            .accessibilityLabel("发送")
        }
    }

    private var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    private func send() {
        if store.send(chatId, text: draft) { draft = "" }
    }

    #if DEBUG
    private func autoSend() {
        guard let text = UserDefaults.standard.string(forKey: "localAutoSend"),
              chat?.messages.isEmpty == true else { return }
        store.send(chatId, text: text)
    }
    #endif
}
