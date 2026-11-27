import SwiftUI

/// 「终端」tab：电脑当前布局的镜像，按布局分组、pane 顺序排卡；点卡接管终端。
struct MirrorTabView: View {
    let api: APIClient
    let model: MirrorModel
    let onRefresh: () async -> Void
    @Environment(AppModel.self) private var app
    @State private var path: [TerminalRoute]
    @State private var pendingKill: MirrorCard?
    @State private var killError: String?

    init(api: APIClient, model: MirrorModel, onRefresh: @escaping () async -> Void) {
        self.api = api
        self.model = model
        self.onRefresh = onRefresh
        // 调试：`-openSession <id>` 启动后直接进入该会话终端
        let debug = UserDefaults.standard.string(forKey: "openSession")
        _path = State(initialValue: debug.map { [TerminalRoute(sessionId: $0, title: "调试会话")] } ?? [])
    }

    var body: some View {
        NavigationStack(path: $path) {
            list
                .overlay { emptyState }
                .refreshable { await onRefresh() }
                .navigationTitle("终端")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { toolbar }
                .navigationDestination(for: TerminalRoute.self) { route in
                    TerminalScreen(sessionId: route.sessionId, title: route.title, api: api, canWrite: app.canWrite)
                }
                .confirmationDialog("关闭会话？", isPresented: killBinding, titleVisibility: .visible,
                                    presenting: pendingKill) { card in
                    Button("关闭会话", role: .destructive) { Task { await kill(card) } }
                } message: { card in
                    Text("将终止「\(card.title)」及其整棵进程树。")
                }
                .alert("关闭失败", isPresented: errorBinding) {
                    Button("好") {}
                } message: {
                    Text(killError ?? "")
                }
        }
    }

    private var list: some View {
        List {
            if let error = model.error {
                Text(error).font(.footnote).foregroundStyle(.red)
            }
            ForEach(model.state.groups) { group in
                Section {
                    ForEach(group.cards) { card in row(card) }
                } header: {
                    MirrorGroupHeader(group: group)
                }
            }
        }
        .readableContentWidth()
    }

    private func row(_ card: MirrorCard) -> some View {
        NavigationLink(value: TerminalRoute(sessionId: card.sessionId, title: card.title)) {
            MirrorCardRow(card: card, preview: model.previews[card.sessionId])
        }
        .task(id: card.sessionId) { await model.loadPreview(for: card.sessionId) }
        .swipeActions(edge: .trailing) {
            if app.canWrite {
                Button("关闭", systemImage: "xmark", role: .destructive) { pendingKill = card }
            }
        }
        .contextMenu {
            if app.canWrite {
                Button("关闭会话", systemImage: "xmark.circle", role: .destructive) { pendingKill = card }
            }
        }
    }

    @ViewBuilder private var emptyState: some View {
        if model.loaded, model.state.isEmpty, model.error == nil {
            ContentUnavailableView {
                Label(model.state.snapshotAvailable ? "电脑当前没有在跑的会话" : "电脑未运行或未打开 CC-Panes 前端",
                      systemImage: "desktopcomputer.trianglebadge.exclamationmark")
            } description: {
                Text("到「工作区」点按项目即可启动一个")
            }
        } else if !model.loaded {
            ProgressView()
        }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            VStack(spacing: 0) {
                Text(model.state.workspaceName ?? app.serverURL)
                    .font(.headline)
                    .lineLimit(1)
                TimelineView(.periodic(from: .now, by: 5)) { context in
                    Text(syncAgoText(model.state.savedAt, now: context.date))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
            if model.state.stale {
                StatusPill(systemImage: "clock.badge.exclamationmark", text: "数据陈旧", color: .orange)
            }
            if !app.canWrite {
                StatusPill(text: "只读", color: .secondary)
            }
        }
    }

    private var killBinding: Binding<Bool> {
        Binding(get: { pendingKill != nil }, set: { if !$0 { pendingKill = nil } })
    }

    private var errorBinding: Binding<Bool> {
        Binding(get: { killError != nil }, set: { if !$0 { killError = nil } })
    }

    private func kill(_ card: MirrorCard) async {
        do {
            try await model.kill(card.sessionId)
        } catch APIError.forbidden {
            killError = "远程只读模式已拦截。可在桌面端开启「允许已登录的远程会话写入」。"
        } catch {
            killError = error.localizedDescription
        }
    }
}
