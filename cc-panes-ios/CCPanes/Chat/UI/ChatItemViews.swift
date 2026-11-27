import SwiftUI

/// 一条对话条目的渲染分派。
struct ChatItemView: View {
    let item: ChatItem
    let terminals: [String: AcpTerminalOutput]

    var body: some View {
        Group {
            switch item.kind {
            case .user(let text):
                UserBubble(text: text, pending: item.promptPending && (item.echoRemaining ?? "").isEmpty == false,
                           origin: item.origin == "mobile" ? nil : item.origin)
            case .assistant(let text): MarkdownView(text: text).frame(maxWidth: .infinity, alignment: .leading)
            case .thought(let text, let done): ThoughtRow(text: text, done: done)
            case .toolCall(let call): ToolCallCard(call: call, terminals: terminals)
            case .plan(let entries): PlanCard(entries: entries)
            case .image(let mime): NoticeRow(text: "[图片 \(mime)]", systemImage: "photo")
            case .notice(let text): NoticeRow(text: text)
            }
        }
        // 子 agent 产出的条目缩进，暗示归属
        .padding(.leading, item.parentToolCallId == nil ? 0 : 14)
    }
}

struct UserBubble: View {
    let text: String
    var pending = false
    /// 非本机发出的消息标注来源（电脑 / Bot / 其他设备）。
    var origin: String?

    var body: some View {
        HStack {
            Spacer(minLength: 48)
            VStack(alignment: .trailing, spacing: 2) {
                if let origin {
                    Text("来自\(AcpOrigin.label(origin))").font(.caption2).foregroundStyle(.secondary)
                }
                Text(text)
                    .textSelection(.enabled)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color.accentColor.opacity(0.28), in: RoundedRectangle(cornerRadius: 16))
                    .opacity(pending ? 0.85 : 1)
            }
        }
    }
}

/// 思考流：默认折叠成一行，流式中显示「思考中…」。
struct ThoughtRow: View {
    let text: String
    let done: Bool
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.snappy) { expanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "brain")
                    Text(done ? "已思考" : "思考中…")
                    if !expanded {
                        Text(text.replacingOccurrences(of: "\n", with: " "))
                            .lineLimit(1)
                            .foregroundStyle(.tertiary)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.caption2)
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            if expanded {
                Text(text)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .padding(.leading, 22)
            }
        }
    }
}

struct NoticeRow: View {
    let text: String
    var systemImage = "info.circle"

    var body: some View {
        Label(text, systemImage: systemImage)
            .font(.caption)
            .foregroundStyle(.orange)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
    }
}

struct PlanCard: View {
    let entries: [AcpPlanEntry]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("计划 · \(entries.filter { $0.status == "completed" }.count)/\(entries.count)",
                  systemImage: "list.bullet.clipboard")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
            ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: entry.statusSymbol)
                        .foregroundStyle(entry.status == "completed" ? .green : entry.status == "in_progress" ? .blue : .secondary)
                        .font(.footnote)
                    Text(entry.content)
                        .font(.subheadline)
                        .strikethrough(entry.status == "completed", color: .secondary)
                        .foregroundStyle(entry.status == "completed" ? .secondary : .primary)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
    }
}
