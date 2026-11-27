import SwiftUI

/// 「对话」tab：活会话（含电脑端开的）+ 历史续接 + 新建。
struct ChatTabView: View {
    let model: ChatListModel
    let workspaces: WorkspacesModel
    @Environment(AppModel.self) private var app
    @State private var path: [ChatRoute]
    @State private var showNew = false
    @State private var resumeError: String?

    init(model: ChatListModel, workspaces: WorkspacesModel) {
        self.model = model
        self.workspaces = workspaces
        // 调试：`-openChat <chatId>` 启动后直接进入该对话
        let debug = UserDefaults.standard.string(forKey: "openChat")
        _path = State(initialValue: debug.map { [ChatRoute(chatId: $0, title: "调试对话", engineId: "claude")] } ?? [])
    }

    var body: some View {
        NavigationStack(path: $path) {
            list
                .overlay { emptyState }
                .refreshable { await model.reload() }
                .navigationTitle("对话")
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("新建对话", systemImage: "square.and.pencil") { showNew = true }
                            .disabled(!app.canWrite || model.hostUnavailable)
                    }
                }
                .navigationDestination(for: ChatRoute.self) { route in
                    ChatScreen(route: route, service: model.service, canWrite: app.canWrite)
                }
                .sheet(isPresented: $showNew) {
                    NewChatSheet(model: model, workspaces: workspaces) { route in
                        showNew = false
                        path.append(route)
                    }
                }
                .alert("续接失败", isPresented: Binding(get: { resumeError != nil }, set: { if !$0 { resumeError = nil } })) {
                    Button("好") {}
                } message: {
                    Text(resumeError ?? "")
                }
        }
        .task { await model.poll() }
        .onChange(of: model.chats) { _, chats in fillDebugRoute(chats) }
    }

    /// `-openChat` 进入时只知道 chatId：列表到达后补上真实标题 / 引擎。
    private func fillDebugRoute(_ chats: [AcpChatSummary]) {
        guard let first = path.first, first.title == "调试对话",
              let chat = chats.first(where: { $0.chatId == first.chatId }) else { return }
        path[0] = model.route(for: chat)
    }

    private var list: some View {
        List {
            if model.hostUnavailable {
                Label("电脑端 CC-Panes 未运行，对话暂不可用", systemImage: "desktopcomputer.trianglebadge.exclamationmark")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            } else if let error = model.error {
                Text(error).font(.footnote).foregroundStyle(.red)
            }
            if !model.chats.isEmpty {
                Section("进行中") {
                    ForEach(model.chats) { chat in
                        NavigationLink(value: model.route(for: chat)) {
                            ChatSummaryRow(chat: chat, engines: model.engines)
                        }
                    }
                }
            }
            if !model.visibleHistory.isEmpty {
                Section("历史对话") {
                    ForEach(model.visibleHistory) { entry in
                        Button { Task { await resume(entry) } } label: {
                            HistoryRow(entry: entry, engines: model.engines)
                        }
                        .buttonStyle(.plain)
                        .disabled(!app.canWrite)
                    }
                }
            }
        }
        .readableContentWidth()
    }

    @ViewBuilder private var emptyState: some View {
        if !model.loaded {
            ProgressView()
        } else if model.chats.isEmpty, model.visibleHistory.isEmpty, !model.hostUnavailable, model.error == nil {
            ContentUnavailableView {
                Label("还没有对话", systemImage: "bubble.left.and.text.bubble.right")
            } description: {
                Text("点右上角新建，选择引擎和项目即可开始")
            }
        }
    }

    private func resume(_ entry: AcpHistoryEntry) async {
        do {
            let route = try await model.create(engineId: entry.engineId, cwd: entry.cwd, resume: entry.acpSessionId)
            path.append(ChatRoute(chatId: route.chatId, title: entry.title, engineId: entry.engineId))
        } catch {
            resumeError = error.localizedDescription
        }
    }
}

struct ChatSummaryRow: View {
    let chat: AcpChatSummary
    let engines: [AcpEngineInfo]

    var body: some View {
        HStack(spacing: 12) {
            EngineIcon(engineId: chat.engineId)
            VStack(alignment: .leading, spacing: 4) {
                Text(chat.displayTitle).font(.body).lineLimit(1)
                HStack(spacing: 6) {
                    Text(AcpEngineStyle.label(chat.engineId, engines: engines))
                    if let cwd = chat.cwd { Text("· \(pathBasename(cwd))").lineLimit(1) }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                HStack(spacing: 6) {
                    StatusPill(text: AcpChatPhase(chat.status).label, color: phaseColor)
                    originPill
                }
            }
            Spacer(minLength: 0)
            if let pending = chat.pendingPermissions, pending > 0 {
                Text("\(pending)")
                    .font(.caption.bold())
                    .foregroundStyle(.white)
                    .frame(minWidth: 22, minHeight: 22)
                    .background(.orange, in: Capsule())
                    .accessibilityLabel("\(pending) 项待审批")
            }
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder private var originPill: some View {
        if chat.isBot {
            StatusPill(systemImage: "person.crop.circle.badge.checkmark", text: "Bot", color: .purple)
        } else {
            StatusPill(systemImage: chat.isMobile ? "iphone" : "desktopcomputer",
                       text: chat.isMobile ? "手机" : "电脑")
        }
    }

    private var phaseColor: Color {
        switch AcpChatPhase(chat.status) {
        case .generating: .blue
        case .ready: .green
        case .starting: .orange
        default: .gray
        }
    }
}

struct HistoryRow: View {
    let entry: AcpHistoryEntry
    let engines: [AcpEngineInfo]

    var body: some View {
        HStack(spacing: 12) {
            EngineIcon(engineId: entry.engineId).opacity(0.7)
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.title.isEmpty ? "未命名对话" : entry.title).lineLimit(1).foregroundStyle(.primary)
                HStack(spacing: 6) {
                    Text(AcpEngineStyle.label(entry.engineId, engines: engines))
                    Text("· \(pathBasename(entry.cwd))").lineLimit(1)
                    if let date = entry.updatedDate { Text("· \(date, format: .relative(presentation: .named))") }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            Image(systemName: "arrow.uturn.forward").font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct EngineIcon: View {
    let engineId: String

    var body: some View {
        Image(systemName: AcpEngineStyle.symbol(engineId))
            .font(.system(size: 16, weight: .semibold))
            .frame(width: 34, height: 34)
            .background(Color.accentColor.opacity(0.18), in: RoundedRectangle(cornerRadius: 9))
            .foregroundStyle(Color.accentColor)
    }
}
