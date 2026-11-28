import SwiftUI

/// 会话状态 → 文案 / 颜色（对齐 Flutter mirror_card 的口径）。
enum SessionStatusStyle {
    static func label(_ status: String, exited: Bool) -> String {
        if exited { return "已退出" }
        switch status {
        case "initializing": return "启动中"
        case "active": return "运行中"
        case "idle": return "空闲"
        case "thinking": return "思考中"
        case "toolRunning": return "工具执行中"
        case "compacting": return "压缩上下文"
        case "waitingInput": return "等待输入"
        case "exited": return "已退出"
        default: return status
        }
    }

    static func color(_ status: String, exited: Bool) -> Color {
        if exited { return .gray }
        switch status {
        case "idle": return .green
        case "waitingInput": return .orange
        case "active", "thinking", "toolRunning", "compacting": return .blue
        default: return .gray
        }
    }
}

/// CLI 名称显示：claude → Claude、codex → Codex，其余原样。
func cliDisplayName(_ raw: String) -> String {
    switch raw.lowercased() {
    case "claude": "Claude"
    case "codex": "Codex"
    default: raw
    }
}

/// 卡片上的小标签（CLI / Pane N）。
struct TagBadge: View {
    let text: String
    var prominent = false

    var body: some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(prominent ? Color.accentColor.opacity(0.22) : Color.secondary.opacity(0.18),
                        in: RoundedRectangle(cornerRadius: 6))
            .foregroundStyle(prominent ? Color.accentColor : Color.secondary)
    }
}

/// 图标 + 文字的半透明胶囊（项目「电脑在跑 / 手机打开」、工作空间 pills、陈旧提示）。
struct StatusPill: View {
    var systemImage: String?
    let text: String
    var color: Color = .secondary

    var body: some View {
        HStack(spacing: 3) {
            if let systemImage { Image(systemName: systemImage).imageScale(.small) }
            Text(text).lineLimit(1)
        }
        .font(.caption2.weight(.semibold))
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(color.opacity(0.15), in: Capsule())
        .foregroundStyle(color)
    }
}

/// 宽屏（iPad）时列表内容居中、不超过 840pt；两侧留白仍可滚动和下拉刷新。
struct ReadableContentWidth: ViewModifier {
    var maxWidth: CGFloat = 840
    @State private var margin: CGFloat = 0

    func body(content: Content) -> some View {
        // margin 为 0（手机宽度）时不设 contentMargins：否则会覆盖 insetGrouped 自带的左右缩进
        content
            .contentMargins(.horizontal, margin > 0 ? margin : nil, for: .scrollContent)
            .onGeometryChange(for: CGFloat.self) { proxy in
                max(0, (proxy.size.width - maxWidth) / 2)
            } action: { margin = $0 }
    }
}

extension View {
    func readableContentWidth() -> some View { modifier(ReadableContentWidth()) }
}

/// 「同步于 N 秒前」。
func syncAgoText(_ saved: Date?, now: Date = .now) -> String {
    guard let saved else { return "电脑镜像" }
    let seconds = Int(now.timeIntervalSince(saved))
    switch seconds {
    case ..<10: return "同步于 刚刚"
    case ..<60: return "同步于 \(seconds) 秒前"
    case ..<3600: return "同步于 \(seconds / 60) 分钟前"
    default: return "同步于 \(seconds / 3600) 小时前"
    }
}
