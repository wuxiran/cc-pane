import SwiftUI

// 首页外壳（iOS 26 Liquid Glass）：tab 栏下滑收起、底部状态条（tabViewBottomAccessory）、
// 各 tab 右上角统一的「电脑」按钮。iOS 18 回落：状态条以 safeAreaInset 落在各 tab 底部，其余照常。

extension ComputerSheetPage: Identifiable {
    var id: Self { self }
}

/// 状态条数据 + 点按动作（HomeView 计算，经 environment 给 iOS 18 回落条与 tab 用）。
struct HomeStatusContext {
    var status: HomeStatus
    var tap: @MainActor () -> Void
}

extension EnvironmentValues {
    @Entry var homeStatus: HomeStatusContext?
}

/// TabView 级：iOS 26 下滑收起 tab 栏 + 底部状态条。
struct HomeGlassChrome: ViewModifier {
    let context: HomeStatusContext
    /// 全屏终端时隐藏状态条（iOS 26.1+ 才有 isEnabled；26.0 上状态条留着，tab 栏照常隐藏）。
    let hidden: Bool

    func body(content: Content) -> some View {
        if #available(iOS 26.1, *) {
            content
                .tabBarMinimizeBehavior(.onScrollDown)
                .tabViewBottomAccessory(isEnabled: !hidden) { HomeStatusBar(context: context) }
        } else if #available(iOS 26, *) {
            content
                .tabBarMinimizeBehavior(.onScrollDown)
                .tabViewBottomAccessory { HomeStatusBar(context: context) }
        } else {
            content
        }
    }
}

extension View {
    /// 每个 tab 根视图：右上角电脑按钮；iOS 18 底部回落状态条。
    func homeTabChrome() -> some View { modifier(HomeTabChrome()) }
}

private struct HomeTabChrome: ViewModifier {
    @Environment(HomeRouter.self) private var router
    @Environment(\.homeStatus) private var status

    func body(content: Content) -> some View {
        content
            .toolbar {
                if #available(iOS 26, *) {
                    ToolbarSpacer(.fixed, placement: .topBarTrailing)
                    ToolbarItem(placement: .topBarTrailing) { avatar }
                        .sharedBackgroundVisibility(.hidden)
                } else {
                    ToolbarItem(placement: .topBarTrailing) { avatar }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if #unavailable(iOS 26), let status {
                    HomeStatusBar(context: status)
                        .frame(height: 44)
                        .background(.bar)
                        .overlay(alignment: .top) { Divider() }
                }
            }
    }

    private var avatar: some View {
        ComputerAvatarButton(level: status?.status.level ?? .connecting) { router.sheet = .computers }
    }
}

// MARK: - 电脑按钮

/// 右上角「电脑」头像：显示器图标 + 连接状态点；点按打开电脑 / 设置面板。
struct ComputerAvatarButton: View {
    let level: HomeStatus.Level
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "desktopcomputer")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 34, height: 34)
                .background(Color.accentColor.opacity(0.16), in: Circle())
                .overlay(alignment: .bottomTrailing) {
                    Circle()
                        .fill(level.color)
                        .frame(width: 10, height: 10)
                        .overlay(Circle().strokeBorder(Color(uiColor: .systemBackground), lineWidth: 2))
                        .offset(x: 1, y: 1)
                }
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("电脑与设置")
        .accessibilityValue(level.label)
    }
}

extension HomeStatus.Level {
    var color: Color {
        switch self {
        case .online: .green
        case .connecting: .gray
        case .warning: .orange
        }
    }

    var label: String {
        switch self {
        case .online: "已连接"
        case .connecting: "连接中"
        case .warning: "有电脑连接异常"
        }
    }
}

// MARK: - 底部状态条

/// 连接状态 + 待审批。展开态一行：状态点 · 电脑 / 在线台数 · 线路或异常原因 · 待审批胶囊；
/// 收起态（tab 栏缩成小圆时与之并排）只保留点 + 标题 + 数字。
struct HomeStatusBar: View {
    let context: HomeStatusContext

    var body: some View {
        if #available(iOS 26, *) {
            AdaptiveStatusBar(context: context)
        } else {
            StatusBarContent(context: context, compact: false)
        }
    }
}

@available(iOS 26, *)
private struct AdaptiveStatusBar: View {
    let context: HomeStatusContext
    @Environment(\.tabViewBottomAccessoryPlacement) private var placement

    var body: some View {
        StatusBarContent(context: context, compact: placement == .inline)
    }
}

private struct StatusBarContent: View {
    let context: HomeStatusContext
    let compact: Bool

    private var status: HomeStatus { context.status }

    var body: some View {
        Button { context.tap() } label: {
            HStack(spacing: 8) {
                StatusDot(level: status.level)
                Text(status.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                if !compact, let detail = status.detail {
                    Text(detail)
                        .font(.subheadline)
                        .foregroundStyle(status.level == .warning ? Color.orange : Color.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                trailing
            }
            .padding(.horizontal, 16)
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint(hint)
    }

    @ViewBuilder private var trailing: some View {
        if status.level == .warning, !compact {
            Label("重连", systemImage: "arrow.clockwise")
                .labelStyle(.titleAndIcon)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.orange)
        } else if status.pending > 0 {
            HStack(spacing: 3) {
                Image(systemName: "hand.raised.fill").imageScale(.small)
                Text(compact ? "\(status.pending)" : "\(status.pending) 待审批").monospacedDigit()
            }
            .font(.caption.weight(.bold))
            .foregroundStyle(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(.orange, in: Capsule())
            .fixedSize()
        } else if !compact {
            Image(systemName: "chevron.up")
                .font(.caption.weight(.bold))
                .foregroundStyle(.tertiary)
        }
    }

    private var hint: String {
        if status.level == .warning { return "重新连接" }
        return status.pending > 0 ? "前往第一条待审批" : "打开电脑列表"
    }
}

private struct StatusDot: View {
    let level: HomeStatus.Level

    var body: some View {
        Group {
            if level == .connecting {
                ProgressView().controlSize(.mini)
            } else {
                Circle().fill(level.color)
                    .overlay(Circle().fill(level.color.opacity(0.35)).scaleEffect(1.9))
            }
        }
        .frame(width: 8, height: 8)
    }
}

// MARK: - 电脑芯片（多电脑时行内标注所属电脑）

struct ComputerChip: View {
    let name: String
    var online = true

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "desktopcomputer").imageScale(.small)
            Text(name).lineLimit(1).truncationMode(.middle)
        }
        .font(.caption2.weight(.medium))
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .foregroundStyle(online ? Color.secondary : Color.orange)
        .background(Color.secondary.opacity(0.12), in: Capsule())
        .frame(maxWidth: 130, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
    }
}

/// 某台电脑的状态说明（对话 / 工作区列表里一台电脑不可用时的一行）。
struct LinkIssueRow: View {
    let name: String
    let message: String
    var symbol = "wifi.slash"

    var body: some View {
        Label {
            Text("\(name)：\(message)")
        } icon: {
            Image(systemName: symbol).foregroundStyle(.orange)
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
    }
}

extension ComputerLink {
    /// 列表里一行提示（nil = 正常）。
    var issue: (message: String, symbol: String)? {
        switch status {
        case .connecting: nil
        case .online:
            hostDown ? ("电脑端 CC-Panes 未运行", "desktopcomputer.trianglebadge.exclamationmark") : nil
        case .offline: ("离线，正在重试", "wifi.slash")
        case .unauthorized: ("令牌失效，请重新配对", "key.slash")
        case .needsLogin: ("需要登录", "person.badge.key")
        case .failed(let m): (m, "exclamationmark.triangle")
        }
    }
}

// MARK: - 搜索语料

enum SearchCorpus {
    @MainActor
    static func build(_ hub: ConnectionHub) -> UnifiedSearch.Corpus {
        let computers = hub.links.filter(\.status.isOnline).map { link in
            let tag = UnifiedSearch.Tag(id: link.id, name: hub.name(link.id))
            return UnifiedSearch.Computer(
                tag: tag,
                chats: link.chats?.chats ?? [],
                history: link.chats?.visibleHistory ?? [],
                workspaces: link.workspaces?.workspaces ?? [],
                mirror: link.mirror?.state.groups ?? [])
        }
        return UnifiedSearch.Corpus(computers: computers, contacts: hub.contacts.sections(query: ""),
                                    local: LocalEnvironment.shared.chats.listItems)
    }
}
