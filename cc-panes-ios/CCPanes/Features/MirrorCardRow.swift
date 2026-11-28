import SwiftUI

/// 会话卡：CLI 徽标 + 标题 + 相位胶囊；元信息「窗格 N · 项目 · 工具 · 时间」；降噪后的最近输出。
/// 等待输入的卡加橙色描边，已退出的卡降低不透明度。
struct MirrorCardRow: View {
    let card: MirrorCard
    let preview: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 12) {
                CLIGlyph(tool: card.cliTool, size: 36)
                    .overlay(alignment: .bottomTrailing) { paneBadge }
                VStack(alignment: .leading, spacing: 3) {
                    Text(card.displayTitle)
                        .font(.headline)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(meta)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 6)
                PhaseCapsule(phase: card.phase, text: capsuleText)
            }
            if let preview {
                Text(preview)
                    .font(.footnote)
                    .foregroundStyle(card.phase == .waiting ? Color.primary : Color.secondary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(card.phase == .waiting ? Color.orange.opacity(0.1) : DK.inset,
                                in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
        }
        .cardSurface(stroke: card.phase == .waiting ? Color.orange.opacity(0.8) : nil)
        .opacity(card.phase == .exited ? 0.6 : 1)
        .accessibilityElement(children: .combine)
    }

    /// 窗格序号角标（对应顶部布局地图里的数字）。
    @ViewBuilder private var paneBadge: some View {
        if let pane = card.paneOrdinal {
            Text("\(pane)")
                .font(.system(size: 10, weight: .bold).monospacedDigit())
                .foregroundStyle(.primary)
                .frame(width: 16, height: 16)
                .background(DK.card, in: Circle())
                .overlay(Circle().strokeBorder(Color.secondary.opacity(0.4), lineWidth: 1))
                .offset(x: 5, y: 5)
                .accessibilityLabel("窗格 \(pane)")
        }
    }

    private var capsuleText: String? {
        if card.phase == .running, let tool = card.info.currentToolName, !tool.isEmpty { return tool }
        return nil
    }

    private var meta: String {
        var parts: [String] = []
        if let reason = card.orphanReason { parts.append(reason) }
        if let project = card.projectName, !project.isEmpty, project != card.displayTitle { parts.append(project) }
        parts.append(card.cliTool.flatMap { $0.isEmpty || $0 == "none" ? nil : cliDisplayName($0) } ?? "Shell")
        if let ago = shortRelative(dateFromMillis(card.info.lastOutputAt ?? card.info.updatedAt)) { parts.append(ago) }
        return parts.joined(separator: " · ")
    }
}
