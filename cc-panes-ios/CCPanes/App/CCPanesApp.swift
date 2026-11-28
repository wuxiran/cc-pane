import SwiftUI

@main
struct CCPanesApp: App {
    @State private var model = AppModel()
    @AppStorage(AppAppearance.key) private var appearance = AppAppearance.dark.rawValue

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(AppAppearance(rawValue: appearance)?.colorScheme)
                .task {
                    let defaults = UserDefaults.standard
                    // 调试：`-pairAddress <url> -pairCode <6位>` 启动即配对（配合本地假服务验证）；
                    // `-autoConnect YES` 启动即连接当前电脑（无界面模拟器 / UI 自动化用）。
                    if let address = defaults.string(forKey: "pairAddress"), let code = defaults.string(forKey: "pairCode") {
                        await model.pair(address: address, code: code)
                    } else if let raw = defaults.string(forKey: "directAddress") {
                        // 调试：`-directAddress <url>[,<url>…]` 启动即把这些地址记为电脑并同时连接（免登录服务端 / 截图用）
                        model.addDirect(raw.split(separator: ",").map { String($0) })
                    }
                    // `-autoConnect YES` 保留兼容：地址簿里「保持连接」的电脑本来就会自动连上。
                }
        }
    }
}

/// 外观：跟随系统 / 浅色 / 深色（设置页可改；调试 `-appearance light|dark`）。
enum AppAppearance: String, CaseIterable, Identifiable {
    case system, light, dark
    static let key = "appearance"
    var id: String { rawValue }
    var label: String {
        switch self {
        case .system: "跟随系统"
        case .light: "浅色"
        case .dark: "深色"
        }
    }
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.showsHome {
            HomeView(hub: model.hub)
        } else {
            ConnectView()
        }
    }
}

/// 首页：对话 · 通讯录 · 终端 · 工作区 四个主 tab + 独立搜索 tab，数据来自同时在线的全部电脑（ConnectionHub）。
/// 角标 = 各电脑之和：对话 = 非 Bot 对话待审批、通讯录 = Bot 待审批、终端 = 等待输入。
/// iOS 26：Liquid Glass tab 栏下滑收起 + 底部状态条（tabViewBottomAccessory）；iOS 18：状态条落在各 tab 底部。
/// iPad 宽屏走 `.sidebarAdaptable` 侧栏。设置 / 电脑管理从各 tab 右上角的电脑按钮进入。
struct HomeView: View {
    let hub: ConnectionHub
    @Environment(\.scenePhase) private var scenePhase
    @State private var router = HomeRouter(tab: HomeTab.initial(), sheet: HomeTab.initialSheet())

    var body: some View {
        @Bindable var router = router
        TabView(selection: $router.tab) {
            Tab("对话", systemImage: "bubble.left.and.bubble.right", value: HomeTab.chat) {
                ChatTabView(hub: hub)
            }
            .badge(hub.chatPending)
            Tab("通讯录", systemImage: "person.2", value: HomeTab.contacts) {
                ContactsTabView(hub: hub)
            }
            .badge(hub.contacts.remotePending)
            Tab("终端", systemImage: "apple.terminal", value: HomeTab.terminal) {
                MirrorTabView(hub: hub)
            }
            .badge(hub.terminalWaiting)
            Tab("工作区", systemImage: "folder", value: HomeTab.workspace) {
                WorkspaceTabView(hub: hub)
            }
            Tab(value: HomeTab.search, role: .search) {
                SearchTabView(hub: hub)
            }
        }
        .tabViewStyle(.sidebarAdaptable)
        .modifier(HomeGlassChrome(context: statusContext, hidden: router.immersive > 0))
        .environment(router)
        .environment(\.homeStatus, statusContext)
        .sheet(item: $router.sheet) { page in
            ComputersSheet(hub: hub, initialPage: page)
        }
        .task { await hub.run() }
        .onChange(of: router.tab, initial: true) { _, tab in hub.visibleTab = tab }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await hub.refreshAll() } }
        }
    }

    private var statusContext: HomeStatusContext {
        HomeStatusContext(status: status, tap: statusTapped)
    }

    private var status: HomeStatus {
        var entries = hub.links.map { link in
            HomeStatus.Entry(name: hub.name(link.id), status: link.status, via: link.via,
                             hostDown: link.hostDown, linkFailing: link.linkFailing)
        }
        #if DEBUG
        // 调试：`-simulateOffline YES` 把第一台电脑显示为离线（截图验证状态条离线态）
        if UserDefaults.standard.bool(forKey: "simulateOffline"), !entries.isEmpty { entries[0].status = .offline }
        #endif
        return HomeStatus.make(entries, pending: pendingItems.count)
    }

    /// 全部待审批（对话含 Bot 对话）——与搜索 tab 空查询的「需要你处理」同口径（不含终端等待输入）。
    private var pendingItems: [HomeDestination] {
        UnifiedSearch.suggestions(SearchCorpus.build(hub))
            .flatMap(\.hits)
            .filter { if case .terminal = $0 { false } else { true } }
            .map(\.destination)
    }

    /// 状态条点按：异常 → 重连（令牌失效 / 需登录 → 打开电脑面板）；有待审批 → 跳到第一条；否则打开电脑面板。
    private func statusTapped() {
        if status.level == .warning, let bad = hub.troubled.first {
            if bad.status == .unauthorized || bad.status == .needsLogin {
                router.sheet = .computers
            } else {
                Task { await hub.reconnect(bad.id) }
            }
            return
        }
        if let first = pendingItems.first {
            router.open(first)
        } else {
            router.sheet = .computers
        }
    }
}

/// 打开终端的导航目标。
struct TerminalRoute: Hashable {
    let sessionId: String
    let title: String
    /// 会话所在电脑（ConnectionHub 的 link id）。
    var computerId: String = ""
}
