import SwiftUI

/// 活动卡：一串连续工具调用合成一张卡，每个调用一行（图标 + 标题 + 位置 + 状态），点按展开详情。
struct ToolActivityCard: View {
    let items: [ChatItem]
    let terminals: [String: AcpTerminalOutput]

    private var calls: [(id: String, call: AcpToolCall)] {
        items.compactMap { item in
            if case .toolCall(let call) = item.kind { return (item.id, call) }
            return nil
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(calls.enumerated()), id: \.element.id) { index, entry in
                if index > 0 { Divider().padding(.leading, 44) }
                ToolCallRow(call: entry.call, terminals: terminals)
            }
        }
        .background(DK.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(calls.contains { $0.call.status == "failed" } ? Color.red.opacity(0.5) : Color.primary.opacity(0.06))
        }
    }
}

/// 单个工具调用行。
struct ToolCallRow: View {
    let call: AcpToolCall
    let terminals: [String: AcpTerminalOutput]
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.snappy) { expanded.toggle() }
            } label: {
                header
            }
            .buttonStyle(.plain)
            if expanded {
                details
                    .padding(.horizontal, 12)
                    .padding(.bottom, 12)
                    .transition(.opacity)
            }
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: kindSymbol)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: 24, height: 24)
                .background(DK.inset, in: Circle())
            VStack(alignment: .leading, spacing: 1) {
                Text(call.displayTitle).font(.subheadline).lineLimit(1)
                if let location = call.locations.first {
                    Text(location).font(.caption2.monospaced()).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.head)
                }
            }
            Spacer(minLength: 4)
            statusIcon
            Image(systemName: "chevron.right")
                .font(.caption2.weight(.bold))
                .foregroundStyle(.tertiary)
                .rotationEffect(.degrees(expanded ? 90 : 0))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityValue(AcpToolCall.statusLabel(call.status))
    }

    @ViewBuilder private var statusIcon: some View {
        switch call.status {
        case "in_progress":
            ProgressView().controlSize(.mini)
        case "completed":
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).font(.footnote)
        case "failed":
            Image(systemName: "xmark.octagon.fill").foregroundStyle(.red).font(.footnote)
        default:
            Text(AcpToolCall.statusLabel(call.status))
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.orange)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Color.orange.opacity(0.14), in: Capsule())
        }
    }

    @ViewBuilder private var details: some View {
        VStack(alignment: .leading, spacing: 8) {
            if call.renderedContent.isEmpty, let input = call.rawInput {
                monospaced(input.compactText, lineLimit: 12)
            }
            ForEach(Array(call.renderedContent.enumerated()), id: \.offset) { _, piece in
                pieceView(piece)
            }
        }
    }

    @ViewBuilder private func pieceView(_ piece: ToolContentPiece) -> some View {
        switch piece {
        case .text(let text): monospaced(text, lineLimit: 30)
        case .unknown(let text): Text(text).font(.caption).foregroundStyle(.secondary)
        case .diff(let path, let old, let new): DiffPreview(path: path, lines: ToolContentPiece.diffLines(old: old, new: new))
        case .terminal(let id):
            if let output = terminals[id] {
                monospaced(output.output + (output.exitCode.map { "\n[退出码 \($0)]" } ?? ""), lineLimit: 30)
            } else {
                Text("终端 \(id)：等待输出…").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func monospaced(_ text: String, lineLimit: Int) -> some View {
        Text(text)
            .font(.system(.caption, design: .monospaced))
            .lineLimit(lineLimit)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(8)
            .background(DK.inset, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private var kindSymbol: String {
        switch call.kind {
        case "read": "doc.text"
        case "edit": "pencil"
        case "delete": "trash"
        case "move": "arrow.right.doc.on.clipboard"
        case "search": "magnifyingglass"
        case "execute": "terminal"
        case "think": "brain"
        case "fetch": "globe"
        default: "wrench.and.screwdriver"
        }
    }
}

struct DiffPreview: View {
    let path: String
    let lines: [DiffLine]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(path).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
            ScrollView(.horizontal, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(lines.prefix(60).enumerated()), id: \.offset) { _, line in
                        Text("\(String(line.sign)) \(line.text)")
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(line.sign == "+" ? .green : line.sign == "-" ? .red : .secondary)
                            .fixedSize()
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(line.sign == "+" ? Color.green.opacity(0.1) : line.sign == "-" ? Color.red.opacity(0.1) : .clear)
                    }
                }
            }
        }
        .padding(8)
        .background(DK.inset, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}
