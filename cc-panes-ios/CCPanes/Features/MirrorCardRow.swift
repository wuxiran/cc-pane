import SwiftUI

/// 镜像会话卡：状态点 + 标题 + CLI / Pane 标签；副标题「项目 · 状态 · 工具」；最近一行输出预览。
struct MirrorCardRow: View {
    let card: MirrorCard
    let preview: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            titleLine
            Text(subtitle)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            if let preview {
                Text(preview)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .padding(.top, 2)
            }
        }
        .padding(.vertical, 2)
    }

    private var titleLine: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(SessionStatusStyle.color(card.info.status, exited: card.info.exited))
                .frame(width: 9, height: 9)
            Text(card.title)
                .font(.body.weight(.semibold))
                .lineLimit(1)
            Spacer(minLength: 4)
            if let cli = card.cliTool, !cli.isEmpty, cli != "none" {
                TagBadge(text: cliDisplayName(cli), prominent: true)
            }
            if let pane = card.paneOrdinal {
                TagBadge(text: "Pane \(pane)" + (card.isActiveLeaf ? "·当前" : ""))
            }
        }
    }

    private var subtitle: String {
        let status = SessionStatusStyle.label(card.info.status, exited: card.info.exited)
        let statusText = card.info.currentToolName.map { "\(status) · \($0)" } ?? status
        if let reason = card.orphanReason { return "\(reason) · \(statusText)" }
        if let project = card.projectName, !project.isEmpty, project != card.title {
            return "\(project) · \(statusText)"
        }
        return statusText
    }
}

/// 分组标题：布局（当前布局带「· 当前」）/ 手机远程 / 孤儿，右侧计数。
struct MirrorGroupHeader: View {
    let group: MirrorGroup

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
            Text(group.title + (group.isCurrentLayout ? " · 当前" : ""))
                .lineLimit(1)
            Spacer()
            Text("\(group.cards.count)").monospacedDigit()
        }
    }

    private var icon: String {
        switch group.kind {
        case .layout: "rectangle.split.2x1"
        case .mobileRemote: "iphone"
        case .orphan: "questionmark.circle"
        }
    }
}
