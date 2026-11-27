import SwiftUI

/// 对话页：流式条目列表 + 底部（停靠卡 + 输入框）。切后台断开、回前台按最后 seq 续传。
struct ChatScreen: View {
    let route: ChatRoute
    @State private var session: AcpChatSession
    @State private var draft = ""
    @State private var confirmStop = false
    @Environment(\.scenePhase) private var scenePhase

    init(route: ChatRoute, service: any AcpService, canWrite: Bool) {
        self.route = route
        _session = State(initialValue: AcpChatSession(chatId: route.chatId, service: service, canWrite: canWrite))
    }

    var body: some View {
        transcript
            .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar }
            .navigationTitle(route.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .onAppear { session.attach() }
            .onDisappear { session.detach() }
            .onChange(of: scenePhase) { _, phase in
                switch phase {
                case .active: session.resume()
                case .background: session.suspend()
                default: break
                }
            }
            .alert("操作失败", isPresented: errorBinding) {
                Button("好") { session.clearActionError() }
            } message: {
                Text(session.actionError ?? "")
            }
            .confirmationDialog("结束此对话？", isPresented: $confirmStop, titleVisibility: .visible) {
                Button("结束对话", role: .destructive) { Task { await session.stop() } }
            } message: {
                Text("将停止 agent 进程；电脑端同一对话也会结束。")
            }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if session.state.items.isEmpty { emptyState }
                    ForEach(session.state.items) { item in
                        ChatItemView(item: item, terminals: session.state.terminals).id(item.id)
                    }
                    if session.isGenerating { GeneratingIndicator() }
                    Color.clear.frame(height: 1).id(Self.bottomId)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: session.state.items.last) { _, _ in
                proxy.scrollTo(Self.bottomId, anchor: .bottom)
            }
            .onChange(of: session.state.dockedCard) { _, card in
                if card != nil { withAnimation { proxy.scrollTo(Self.bottomId, anchor: .bottom) } }
            }
        }
    }

    private static let bottomId = "chat-bottom"

    @ViewBuilder private var emptyState: some View {
        switch session.link {
        case .hostUnavailable:
            ContentUnavailableView("电脑端未运行", systemImage: "desktopcomputer.trianglebadge.exclamationmark",
                                   description: Text("打开电脑上的 CC-Panes 后会自动重连"))
        case .connecting, .reconnecting:
            ProgressView("正在连接对话…").frame(maxWidth: .infinity).padding(.top, 80)
        default:
            ContentUnavailableView("开始对话", systemImage: AcpEngineStyle.symbol(route.engineId),
                                   description: Text("向 \(AcpEngineStyle.label(route.engineId)) 描述你要做的事"))
        }
    }

    private var bottomBar: some View {
        VStack(spacing: 8) {
            dockedCard
            ChatComposer(session: session, draft: $draft)
        }
        .padding(.top, 6)
        .background(.bar)
        .animation(.snappy, value: session.state.dockedCard)
    }

    /// 同一时刻只显示一张卡（t3code 做法）：审批优先，其次提问。
    @ViewBuilder private var dockedCard: some View {
        switch session.state.dockedCard {
        case .permission(let request):
            PermissionCard(request: request, queued: session.state.pendingPermissions.count - 1 + session.state.pendingQuestions.count,
                           readOnly: session.readOnly) { optionId in
                Task { await session.respondPermission(request.requestKey, optionId: optionId) }
            }
            .padding(.horizontal, 12)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        case .question(let request):
            QuestionCardView(request: request, readOnly: session.readOnly) { response in
                Task { await session.respondQuestion(request.requestKey, response: response) }
            }
            .id(request.requestKey)
            .padding(.horizontal, 12)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        case nil:
            EmptyView()
        }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            VStack(spacing: 0) {
                Text(route.title).font(.headline).lineLimit(1)
                HStack(spacing: 4) {
                    Image(systemName: AcpEngineStyle.symbol(route.engineId))
                    Text(subtitle)
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
            if let usage = session.state.usage {
                ZStack {
                    Circle().stroke(.secondary.opacity(0.3), lineWidth: 3)
                    Circle().trim(from: 0, to: usage.fraction)
                        .stroke(usage.fraction > 0.8 ? Color.orange : Color.accentColor,
                                style: StrokeStyle(lineWidth: 3, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                }
                .frame(width: 18, height: 18)
                .accessibilityLabel("上下文已用 \(Int(usage.fraction * 100))%")
            }
            Menu {
                Button("结束对话", systemImage: "stop.circle", role: .destructive) { confirmStop = true }
                    .disabled(session.readOnly || session.state.phase.isTerminal)
            } label: {
                Image(systemName: "ellipsis.circle")
            }
        }
    }

    private var subtitle: String {
        let engine = AcpEngineStyle.label(route.engineId)
        switch session.link {
        case .live: return "\(engine) · \(session.state.phase.label)"
        case .connecting: return "\(engine) · 连接中"
        case .reconnecting: return "\(engine) · 重连中"
        case .suspended: return "\(engine) · 已暂停"
        case .hostUnavailable: return "电脑端未运行"
        case .failed(let message): return message
        }
    }

    private var errorBinding: Binding<Bool> {
        Binding(get: { session.actionError != nil }, set: { if !$0 { session.clearActionError() } })
    }
}

/// 生成中占位：三点跳动。
struct GeneratingIndicator: View {
    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.35)) { context in
            let step = Int(context.date.timeIntervalSinceReferenceDate / 0.35) % 3
            HStack(spacing: 4) {
                ForEach(0..<3) { i in
                    Circle().fill(.secondary).frame(width: 6, height: 6).opacity(i == step ? 1 : 0.35)
                }
            }
            .padding(.vertical, 4)
        }
        .accessibilityLabel("生成中")
    }
}

/// 打开对话的导航目标。
struct ChatRoute: Hashable {
    let chatId: String
    let title: String
    let engineId: String
}
