import Foundation
import Observation

/// 首页四个主 tab + 独立的搜索 tab（iOS 26 渲染为 tab 栏右侧单独的玻璃圆）。
/// 「设置」不再占 tab：从各 tab 右上角的电脑头像进入。
enum HomeTab: String, Hashable, CaseIterable {
    case chat, contacts, terminal, workspace, search

    /// 调试：`-initialTab chat|contacts|terminal|workspace|search|settings`（settings = 落在对话并打开电脑 / 设置面板）；
    /// 带 `-openSession` 时默认落在「终端」，带 `-openChat` 时落在「对话」。
    static func initial(_ defaults: UserDefaults = .standard) -> HomeTab {
        if let raw = defaults.string(forKey: "initialTab") {
            if let tab = HomeTab(rawValue: raw) { return tab }
            if raw == "settings" || raw == "computers" || raw == "localModels" { return .chat }
        }
        if defaults.string(forKey: "openChat") != nil || defaults.string(forKey: "openLocalChat") != nil { return .chat }
        if defaults.string(forKey: "openContact") != nil || defaults.string(forKey: "contactDetail") != nil { return .contacts }
        return defaults.string(forKey: "openSession") == nil ? .workspace : .terminal
    }

    /// `-initialTab settings` 打开设置；`-initialTab computers` 只打开电脑面板。
    static func initialSheet(_ defaults: UserDefaults = .standard) -> ComputerSheetPage? {
        switch defaults.string(forKey: "initialTab") {
        case "settings": .settings
        case "computers": .computers
        case "localModels": .localModels
        default: nil
        }
    }
}

enum ComputerSheetPage: Hashable { case computers, settings, localModels }

/// 跨 tab 跳转目标（统一搜索、底部状态条「去处理」都走这里）。
enum HomeDestination: Equatable {
    /// 对话列表根（「需要你处理」分组在最上面）。
    case chatList
    case chat(ChatRoute)
    case resume(AcpHistoryEntry, computerId: String)
    /// Bot（id = `电脑id/botId`）；detail = 进详情而不是对话（电脑离线时）。
    case contact(String, detail: Bool)
    case project(computerId: String, workspaceId: String, projectId: String)
    case terminal(TerminalRoute)

    var tab: HomeTab {
        switch self {
        case .chatList, .chat, .resume: .chat
        case .contact: .contacts
        case .project: .workspace
        case .terminal: .terminal
        }
    }
}

/// 首页路由：选中 tab + 一个待消费的跳转（目标 tab 出现后取走）+ 电脑面板。
@MainActor
@Observable
final class HomeRouter {
    var tab: HomeTab
    private(set) var pending: HomeDestination?
    var sheet: ComputerSheetPage?
    /// 全屏终端在前台的层数：> 0 时连底部状态条一起藏（tab 栏由终端页自己藏）。
    var immersive = 0

    init(tab: HomeTab = .chat, sheet: ComputerSheetPage? = nil) {
        self.tab = tab
        self.sheet = sheet
    }

    func open(_ destination: HomeDestination) {
        pending = destination
        tab = destination.tab
    }

    /// 目标 tab 取走属于自己的跳转。
    func take(for tab: HomeTab) -> HomeDestination? {
        guard let pending, pending.tab == tab else { return nil }
        self.pending = nil
        return pending
    }
}

/// 底部状态条（tabViewBottomAccessory）的内容：聚合全部「保持连接」的电脑。纯数据，便于测试。
struct HomeStatus: Equatable {
    enum Level: Equatable { case online, connecting, warning }

    var level: Level
    /// 主文案：单台 = 电脑名；多台 = 「N 台在线」。
    var title: String
    /// 线路（单台：局域网 / Tailscale / 直连）或异常原因（「1 台离线」「令牌失效」）。
    var detail: String?
    var pending: Int

    struct Entry: Equatable {
        var name: String
        var status: ComputerLink.Status
        var via: AddressBook.Kind?
        var hostDown = false
        var linkFailing = false
    }

    static func routeLabel(_ kind: AddressBook.Kind?) -> String? {
        switch kind {
        case .lan: "局域网"
        case .tailscale: "Tailscale"
        case .other: "直连"
        case nil: nil
        }
    }

    static func make(_ entries: [Entry], pending: Int) -> HomeStatus {
        guard !entries.isEmpty else {
            return HomeStatus(level: .warning, title: "没有保持连接的电脑", detail: "点按添加", pending: pending)
        }
        let online = entries.filter { $0.status.isOnline && !$0.linkFailing }
        let connecting = entries.filter { $0.status == .connecting }
        let troubled = entries.filter { !$0.status.isOnline && $0.status != .connecting || $0.linkFailing }
        if entries.count == 1, let only = entries.first {
            if only.status == .connecting {
                return HomeStatus(level: .connecting, title: only.name, detail: "连接中…", pending: pending)
            }
            if !troubled.isEmpty {
                return HomeStatus(level: .warning, title: only.name, detail: reason(only), pending: pending)
            }
            let detail = only.hostDown ? "CC-Panes 未运行" : routeLabel(only.via)
            return HomeStatus(level: only.hostDown ? .warning : .online, title: only.name, detail: detail, pending: pending)
        }
        let title = online.isEmpty && !connecting.isEmpty ? "连接中…" : "\(online.count) 台在线"
        if !troubled.isEmpty {
            let detail = troubled.count == 1 ? "\(troubled[0].name) \(reason(troubled[0]))" : "\(troubled.count) 台离线"
            return HomeStatus(level: .warning, title: title, detail: detail, pending: pending)
        }
        if online.isEmpty { return HomeStatus(level: .connecting, title: title, detail: nil, pending: pending) }
        let routes = Set(online.compactMap { routeLabel($0.via) })
        return HomeStatus(level: .online, title: title, detail: routes.count == 1 ? routes.first : nil, pending: pending)
    }

    static func reason(_ entry: Entry) -> String {
        if entry.linkFailing { return "连接中断" }
        switch entry.status {
        case .offline: return "离线"
        case .unauthorized: return "令牌失效"
        case .needsLogin: return "需要登录"
        case .failed: return "连接失败"
        case .connecting: return "连接中"
        case .online: return entry.hostDown ? "CC-Panes 未运行" : "在线"
        }
    }
}
