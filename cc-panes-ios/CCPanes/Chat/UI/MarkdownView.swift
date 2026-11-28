import SwiftUI

/// Markdown 渲染（MarkdownParser 分块 + 行内 AttributedString）。代码块等宽、可横向滚动、长按复制。
struct MarkdownView: View {
    let text: String

    var body: some View {
        let blocks = MarkdownParser.parse(text)
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .textSelection(.enabled)
    }

    @ViewBuilder private func blockView(_ block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let text):
            Text(styled(text))
                .font(level <= 1 ? .title3.bold() : level == 2 ? .headline : .subheadline.bold())
                .padding(.top, 2)
        case .paragraph(let text):
            Text(styled(text)).font(.callout).lineSpacing(2)
        case .bullet(let text, let ordered):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(ordered.map { "\($0)." } ?? "•").foregroundStyle(.secondary).monospacedDigit()
                Text(styled(text)).font(.callout)
            }
        case .quote(let text):
            Text(styled(text))
                .font(.callout)
                .foregroundStyle(.secondary)
                .padding(.leading, 10)
                .overlay(alignment: .leading) { Rectangle().fill(.secondary.opacity(0.5)).frame(width: 3) }
        case .code(let language, let text):
            CodeBlockView(language: language, text: text)
        case .rule:
            Divider()
        }
    }
}

/// 行内代码加浅底 + 等宽小一号，和正文区分开。
private func styled(_ text: String) -> AttributedString {
    var attributed = MarkdownParser.inline(text)
    for run in attributed.runs where run.inlinePresentationIntent?.contains(.code) == true {
        attributed[run.range].backgroundColor = Color.primary.opacity(0.08)
        attributed[run.range].font = .system(.subheadline, design: .monospaced)
    }
    return attributed
}

struct CodeBlockView: View {
    let language: String?
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language ?? "代码").font(.caption2.monospaced()).foregroundStyle(.secondary)
                Spacer()
                Button {
                    UIPasteboard.general.string = text
                } label: {
                    Image(systemName: "doc.on.doc").font(.caption)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("复制代码")
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(Color.primary.opacity(0.04))
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(.system(.caption, design: .monospaced))
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(10)
            }
        }
        .background(DK.inset, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.primary.opacity(0.06)))
    }
}
