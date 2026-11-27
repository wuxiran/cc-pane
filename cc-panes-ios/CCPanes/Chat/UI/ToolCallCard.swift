import SwiftUI

/// 工具调用折叠卡：标题 + 类型 + 状态；展开看 diff / 文本输出 / 终端输出 / 原始入参。
struct ToolCallCard: View {
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
                Divider().opacity(0.4)
                details.padding(10)
            }
        }
        .background(.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(statusColor.opacity(call.status == "failed" ? 0.6 : 0.15)))
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: kindSymbol).foregroundStyle(.secondary).frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(call.displayTitle).font(.subheadline).lineLimit(2)
                if let location = call.locations.first {
                    Text(location).font(.caption2.monospaced()).foregroundStyle(.tertiary).lineLimit(1).truncationMode(.middle)
                }
            }
            Spacer(minLength: 4)
            statusBadge
            Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.caption2).foregroundStyle(.secondary)
        }
        .padding(10)
        .contentShape(Rectangle())
    }

    @ViewBuilder private var statusBadge: some View {
        if call.status == "in_progress" {
            ProgressView().controlSize(.mini)
        } else {
            Text(AcpToolCall.statusLabel(call.status))
                .font(.caption2.weight(.medium))
                .foregroundStyle(statusColor)
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
    }

    private var statusColor: Color {
        switch call.status {
        case "completed": .green
        case "failed": .red
        case "in_progress": .blue
        default: .orange
        }
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
            Text(path).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            ScrollView(.horizontal, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(lines.prefix(60).enumerated()), id: \.offset) { _, line in
                        Text("\(String(line.sign)) \(line.text)")
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(line.sign == "+" ? .green : line.sign == "-" ? .red : .secondary)
                            .fixedSize()
                    }
                }
            }
        }
        .padding(8)
        .background(Color.black.opacity(0.3), in: RoundedRectangle(cornerRadius: 8))
    }
}
