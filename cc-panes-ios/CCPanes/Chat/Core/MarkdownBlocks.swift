import Foundation

/// 轻量 Markdown 分块：围栏代码块单独成块（等宽渲染），标题/列表/引用/段落按行归类；
/// 行内样式（粗体、`code`、链接）交给 AttributedString(markdown:)。
/// 流式输出时未闭合的围栏按代码块处理（与桌面渲染一致，避免闪烁成正文）。
enum MarkdownBlock: Sendable, Equatable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case bullet(String, ordered: String?)
    case quote(String)
    case code(language: String?, text: String)
    case rule
}

enum MarkdownParser {
    static func parse(_ source: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var code: (lang: String?, lines: [String])?

        func flushParagraph() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))) }
            paragraph = []
        }

        for line in source.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if var open = code {
                if trimmed.hasPrefix("```") {
                    blocks.append(.code(language: open.lang, text: open.lines.joined(separator: "\n")))
                    code = nil
                } else {
                    open.lines.append(line)
                    code = open
                }
                continue
            }
            if trimmed.hasPrefix("```") {
                flushParagraph()
                let lang = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                code = (lang.isEmpty ? nil : lang, [])
                continue
            }
            if let block = lineBlock(trimmed) {
                flushParagraph()
                blocks.append(block)
            } else if trimmed.isEmpty {
                flushParagraph()
            } else {
                paragraph.append(line)
            }
        }
        flushParagraph()
        if let open = code { blocks.append(.code(language: open.lang, text: open.lines.joined(separator: "\n"))) }
        return blocks
    }

    /// 单行即成块的结构（标题、列表、引用、分隔线）；普通行返回 nil。
    private static func lineBlock(_ line: String) -> MarkdownBlock? {
        if line == "---" || line == "***" { return .rule }
        if line.hasPrefix("#") {
            let level = line.prefix(while: { $0 == "#" }).count
            let rest = line.dropFirst(level)
            if level <= 6, rest.first == " " { return .heading(level: level, text: rest.trimmingCharacters(in: .whitespaces)) }
        }
        for marker in ["- ", "* ", "+ "] where line.hasPrefix(marker) {
            return .bullet(String(line.dropFirst(2)), ordered: nil)
        }
        if let dot = line.firstIndex(of: "."), line[..<dot].allSatisfy(\.isNumber), !line[..<dot].isEmpty,
           line[line.index(after: dot)...].hasPrefix(" ") {
            return .bullet(String(line[line.index(dot, offsetBy: 2)...]), ordered: String(line[..<dot]))
        }
        if line.hasPrefix("> ") { return .quote(String(line.dropFirst(2))) }
        return nil
    }

    /// 行内 Markdown → AttributedString；解析失败退回纯文本（流式中途的半截语法很常见）。
    static func inline(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace,
                                                              failurePolicy: .returnPartiallyParsedIfPossible)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}
