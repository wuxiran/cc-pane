import SwiftUI

@main
struct CCPanesApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(.dark)
                .task {
                    let defaults = UserDefaults.standard
                    // 调试：`-pairAddress <url> -pairCode <6位>` 启动即配对（配合本地假服务验证）；
                    // `-autoConnect YES` 启动即连接当前电脑（无界面模拟器 / UI 自动化用）。
                    if let address = defaults.string(forKey: "pairAddress"), let code = defaults.string(forKey: "pairCode") {
                        await model.pair(address: address, code: code)
                    } else if defaults.bool(forKey: "autoConnect") {
                        await model.connect()
                    }
                }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        switch model.state {
        case .connected:
            if let api = model.api {
                // 切换电脑 = 新 APIClient：按实例重建首页，丢弃上一台电脑的状态。
                HomeView(api: api).id(ObjectIdentifier(api))
            }
        default:
            ConnectView()
        }
    }
}

/// 首页四 tab：「对话」（ACP Agent Chat，角标为待审批数）/「工作区」（浏览 → 项目 → 启动）/
/// 「终端」（电脑布局镜像，角标为会话数）/「设置」。
/// iPad 宽屏走 `.sidebarAdaptable` 侧栏。镜像在首页层轮询，角标与项目「电脑在跑」徽标实时更新。
struct HomeView: View {
    let api: APIClient
    @State private var mirror: MirrorModel
    @State private var workspaces: WorkspacesModel
    @State private var chats: ChatListModel
    @State private var tab: HomeTab

    init(api: APIClient) {
        self.api = api
        _mirror = State(initialValue: MirrorModel(api: api))
        _workspaces = State(initialValue: WorkspacesModel(api: api))
        _chats = State(initialValue: ChatListModel(service: AcpEnvironment.service(api: api)))
        _tab = State(initialValue: HomeTab.initial())
    }

    var body: some View {
        TabView(selection: $tab) {
            Tab("对话", systemImage: "bubble.left.and.text.bubble.right", value: HomeTab.chat) {
                ChatTabView(model: chats, workspaces: workspaces)
            }
            .badge(chats.pendingTotal)
            Tab("工作区", systemImage: "folder", value: HomeTab.workspace) {
                WorkspaceTabView(api: api, model: workspaces, mirror: mirror, onRefresh: refreshAll)
            }
            Tab("终端", systemImage: "terminal", value: HomeTab.terminal) {
                MirrorTabView(api: api, model: mirror, onRefresh: refreshAll)
            }
            .badge(mirror.state.sessionCount)
            Tab("设置", systemImage: "gearshape", value: HomeTab.settings) {
                NavigationStack { SettingsView() }
            }
        }
        .tabViewStyle(.sidebarAdaptable)
        .task { await mirror.poll() }
        .task { await workspaces.reload() }
    }

    private func refreshAll() async {
        async let a: Void = mirror.refresh()
        async let b: Void = workspaces.reload()
        _ = await (a, b)
    }
}

enum HomeTab: String, Hashable {
    case chat, workspace, terminal, settings

    /// 调试：`-initialTab chat|terminal|workspace|settings`；带 `-openSession` 时默认落在「终端」，
    /// 带 `-openChat` 时落在「对话」。
    static func initial(_ defaults: UserDefaults = .standard) -> HomeTab {
        if let raw = defaults.string(forKey: "initialTab"), let tab = HomeTab(rawValue: raw) { return tab }
        if defaults.string(forKey: "openChat") != nil { return .chat }
        return defaults.string(forKey: "openSession") == nil ? .workspace : .terminal
    }
}

/// 打开终端的导航目标。
struct TerminalRoute: Hashable {
    let sessionId: String
    let title: String
}
