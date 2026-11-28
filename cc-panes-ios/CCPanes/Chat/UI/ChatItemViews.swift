import SwiftUI

/// 渲染分组：连续的工具调用（同一归属）合进一张「活动」卡，其余条目单独成行。
enum ChatRowGroup: Identifiable {
    case single(ChatItem)
    case tools([ChatItem])

    var id: String {
        switch self {
        case .single(let item): item.id
        case .tools(let items): "tools:" + (items.first?.id ?? "")
        }
    }

    var parentToolCallId: String? {
        switch self {
        case .single(let item): item.parentToolCallId
        case .tools(let items): items.first?.parentToolCallId
        }
    }

    static func build(_ items: [ChatItem]) -> [ChatRowGroup] {
        var groups: [ChatRowGroup] = []
        for item in items {
            guard case .toolCall = item.kind else { groups.append(.single(item)); continue }
            if case .tools(var run) = groups.last, run.first?.parentToolCallId == item.parentToolCallId {
                run.append(item)
                groups[groups.count - 1] = .tools(run)
            } else {
                groups.append(.tools([item]))
            }
        }
        return groups
    }
}

/// 一组渲染行。子 agent 产出的条目缩进 + 左侧细线，暗示归属。
struct ChatGroupView: View {
    let group: ChatRowGroup
    let terminals: [String: AcpTerminalOutput]

    var body: some View {
        Group {
            switch group {
            case .single(let item): ChatItemView(item: item, terminals: terminals)
            case .tools(let items): ToolActivityCard(items: items, terminals: terminals)
            }
        }
        .padding(.leading, group.parentToolCallId == nil ? 0 : 12)
        .overlay(alignment: .leading) {
            if group.parentToolCallId != nil {
                Capsule().fill(Color.secondary.opacity(0.3)).frame(width: 2)
            }
        }
    }
}

/// 一条对话条目的渲染分派。
struct ChatItemView: View {
    let item: ChatItem
    let terminals: [String: AcpTerminalOutput]

    var body: some View {
        switch item.kind {
        case .user(let text):
            UserBubble(text: text, pending: item.promptPending && (item.echoRemaining ?? "").isEmpty == false,
                       origin: item.origin == "mobile" ? nil : item.origin)
        case .assistant(let text):
            MarkdownView(text: text).frame(maxWidth: .infinity, alignment: .leading)
        case .thought(let text, let done): ThoughtRow(text: text, done: done)
        case .toolCall: ToolActivityCard(items: [item], terminals: terminals)
        case .plan(let entries): PlanCard(entries: entries)
        case .image(let mime): NoticeRow(text: "图片 \(mime)", systemImage: "photo")
        case .notice(let text): NoticeRow(text: text)
        }
    }
}

struct UserBubble: View {
    let text: String
    var pending = false
    /// 非本机发出的消息标注来源（电脑 / Bot / 其他设备）。
    var origin: String?

    var body: some View {
        HStack {
            Spacer(minLength: 56)
            VStack(alignment: .trailing, spacing: 4) {
                if let origin {
                    Label("来自\(AcpOrigin.label(origin))", systemImage: originSymbol(origin))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Text(text)
                    .font(.callout)
                    .foregroundStyle(.white)
                    .textSelection(.enabled)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(Color.accentColor, in: UnevenRoundedRectangle(
                        topLeadingRadius: 20, bottomLeadingRadius: 20, bottomTrailingRadius: 6, topTrailingRadius: 20,
                        style: .continuous))
                    .opacity(pending ? 0.6 : 1)
                if pending {
                    Text("发送中…").font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func originSymbol(_ origin: String) -> String {
        switch origin {
        case "desktop": "desktopcomputer"
        case "bot": "person.crop.circle.badge.checkmark"
        case "im": "message"
        default: "iphone"
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
                    Image(systemName: "brain").symbolEffect(.pulse, isActive: !done)
                    Text(done ? "已思考" : "思考中…").fontWeight(.medium)
                    if !expanded {
                        Text(text.replacingOccurrences(of: "\n", with: " "))
                            .lineLimit(1)
                            .foregroundStyle(.tertiary)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.bold))
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if expanded {
                Text(text)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .padding(.leading, 10)
                    .overlay(alignment: .leading) { Capsule().fill(Color.secondary.opacity(0.3)).frame(width: 2) }
            }
        }
    }
}

/// 系统提示：居中的灰色小胶囊（不抢正文视线）。
struct NoticeRow: View {
    let text: String
    var systemImage = "info.circle"

    var body: some View {
        Label(text, systemImage: systemImage)
            .font(.caption)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(DK.inset, in: Capsule())
            .frame(maxWidth: .infinity)
    }
}

struct PlanCard: View {
    let entries: [AcpPlanEntry]

    private var done: Int { entries.filter { $0.status == "completed" }.count }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("计划", systemImage: "list.bullet.clipboard").font(.subheadline.weight(.semibold))
                Spacer()
                Text("\(done)/\(entries.count)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            ProgressView(value: Double(done), total: Double(max(entries.count, 1)))
                .tint(.green)
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
        .cardSurface(padding: 12)
    }
}
