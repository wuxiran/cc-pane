import SwiftUI

// 三个主 tab（对话 / 工作区 / 终端）共用的设计语言：相位色、卡片底、CLI 徽标、小标签。
// 规则：分组底色 = systemGroupedBackground，卡片 = secondarySystemGroupedBackground + 16pt 连续圆角；
// 相位色只有四种（等待=橙 / 运行=蓝 / 空闲=绿 / 结束=灰），「等待输入」一律加描边强调。

enum DK {
    static let cardRadius: CGFloat = 16
    static let gutter: CGFloat = 16
    static let canvas = Color(uiColor: .systemGroupedBackground)
    static let card = Color(uiColor: .secondarySystemGroupedBackground)
    static let inset = Color(uiColor: .tertiarySystemFill)
}

extension SessionPhase {
    var color: Color {
        switch self {
        case .waiting: .orange
        case .running: .blue
        case .idle: .green
        case .exited: .gray
        }
    }

    var label: String {
        switch self {
        case .waiting: "等待输入"
        case .running: "运行中"
        case .idle: "空闲"
        case .exited: "已退出"
        }
    }

    var symbol: String {
        switch self {
        case .waiting: "exclamationmark.bubble.fill"
        case .running: "bolt.fill"
        case .idle: "checkmark.circle.fill"
        case .exited: "stop.circle.fill"
        }
    }
}

/// 状态点；运行中带呼吸光晕（尊重「减弱动态效果」）。
struct PhaseDot: View {
    let phase: SessionPhase
    var size: CGFloat = 8
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulse = false

    var body: some View {
        Circle()
            .fill(phase.color)
            .frame(width: size, height: size)
            .background {
                if phase == .running || phase == .waiting, !reduceMotion {
                    Circle()
                        .fill(phase.color.opacity(0.35))
                        .scaleEffect(pulse ? 2.2 : 1)
                        .opacity(pulse ? 0 : 1)
                        .animation(.easeOut(duration: 1.4).repeatForever(autoreverses: false), value: pulse)
                        .onAppear { pulse = true }
                }
            }
            .accessibilityHidden(true)
    }
}

/// 相位胶囊：等待输入为实心橙（最显眼），其余为浅底彩字。
struct PhaseCapsule: View {
    let phase: SessionPhase
    var text: String?

    var body: some View {
        HStack(spacing: 4) {
            if phase == .waiting {
                Image(systemName: phase.symbol).imageScale(.small)
            } else {
                PhaseDot(phase: phase, size: 6)
            }
            Text(text ?? phase.label).lineLimit(1)
        }
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .foregroundStyle(phase == .waiting ? Color.white : phase.color)
        .background(phase == .waiting ? phase.color : phase.color.opacity(0.14), in: Capsule())
        .fixedSize()
    }
}

/// CLI / 引擎徽标：品牌色圆角方块 + SF Symbol。
struct CLIGlyph: View {
    let tool: String?
    var size: CGFloat = 32

    var body: some View {
        Image(systemName: Self.symbol(tool))
            .font(.system(size: size * 0.46, weight: .semibold))
            .foregroundStyle(Self.tint(tool))
            .frame(width: size, height: size)
            .background(Self.tint(tool).opacity(0.15), in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
            .accessibilityHidden(true)
    }

    static func symbol(_ tool: String?) -> String {
        switch tool?.lowercased() {
        case nil, "", "none", "shell", "terminal": "terminal"
        case let t?: AcpEngineStyle.symbol(t)
        }
    }

    static func tint(_ tool: String?) -> Color {
        switch tool?.lowercased() {
        case "claude": Color(red: 0.85, green: 0.47, blue: 0.34) // Claude 陶土橙
        case "codex": .teal
        case "gemini": .blue
        case "grok": .purple
        case "cursor-agent", "cursor": .indigo
        case "copilot": .mint
        case "opencode", "qwen", "kimi": .cyan
        default: .gray
        }
    }
}

/// 卡片底：圆角卡 + 可选强调描边（等待输入 / 选中）。
struct CardSurface: ViewModifier {
    var stroke: Color?
    var padding: CGFloat = 14

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(DK.card, in: RoundedRectangle(cornerRadius: DK.cardRadius, style: .continuous))
            .overlay {
                if let stroke {
                    RoundedRectangle(cornerRadius: DK.cardRadius, style: .continuous)
                        .strokeBorder(stroke, lineWidth: 1.5)
                }
            }
    }
}

extension View {
    func cardSurface(stroke: Color? = nil, padding: CGFloat = 14) -> some View {
        modifier(CardSurface(stroke: stroke, padding: padding))
    }

    /// List 行变成「间距卡片」：去分隔线、透明行底、统一边距。
    func cardRow(top: CGFloat = 5, bottom: CGFloat = 5) -> some View {
        listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: top, leading: DK.gutter, bottom: bottom, trailing: DK.gutter))
    }
}

/// 分节小标题（卡片列表里代替系统 Section header）。
struct SectionLabel: View {
    let title: String
    var systemImage: String?
    var trailing: String?
    var tint: Color = .secondary

    var body: some View {
        HStack(spacing: 6) {
            if let systemImage { Image(systemName: systemImage).imageScale(.small) }
            Text(title)
            Spacer(minLength: 0)
            if let trailing { Text(trailing).monospacedDigit() }
        }
        .font(.footnote.weight(.semibold))
        .foregroundStyle(tint)
        .textCase(nil)
    }
}

/// 「3 分钟前」式短相对时间（列表元信息用）。
func shortRelative(_ date: Date?, now: Date = .now) -> String? {
    guard let date else { return nil }
    let seconds = max(0, Int(now.timeIntervalSince(date)))
    switch seconds {
    case ..<60: return "刚刚"
    case ..<3600: return "\(seconds / 60) 分钟前"
    case ..<86_400: return "\(seconds / 3600) 小时前"
    case ..<(86_400 * 30): return "\(seconds / 86_400) 天前"
    default: return date.formatted(.dateTime.month().day())
    }
}

func dateFromMillis(_ ms: Int64?) -> Date? {
    ms.map { Date(timeIntervalSince1970: Double($0) / 1000) }
}

/// 路径缩写：/Users/x/… → ~/…（仅展示）。
func abbreviatePath(_ path: String) -> String {
    let parts = path.split(separator: "/", omittingEmptySubsequences: true)
    if path.hasPrefix("/Users/"), parts.count >= 2 { return "~/" + parts.dropFirst(2).joined(separator: "/") }
    if path.hasPrefix("/home/"), parts.count >= 2 { return "~/" + parts.dropFirst(2).joined(separator: "/") }
    return path
}

/// 卡片按压反馈：轻微缩放 + 变暗（替代 List 行高亮）。
struct PressableCardStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .brightness(configuration.isPressed ? -0.03 : 0)
            .animation(.snappy(duration: 0.15), value: configuration.isPressed)
            .contentShape(Rectangle())
    }
}
