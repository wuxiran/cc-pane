import XCTest
@testable import CCPanes

final class MarkdownParserTests: XCTestCase {
    func testBlocks() {
        let blocks = MarkdownParser.parse("""
        ## 标题
        第一段
        续行

        - 项一
        2. 项二
        > 引用
        ```swift
        let a = 1
        ```
        """)
        XCTAssertEqual(blocks, [
            .heading(level: 2, text: "标题"),
            .paragraph("第一段\n续行"),
            .bullet("项一", ordered: nil),
            .bullet("项二", ordered: "2"),
            .quote("引用"),
            .code(language: "swift", text: "let a = 1"),
        ])
    }

    func testUnclosedFenceWhileStreamingIsCode() {
        XCTAssertEqual(MarkdownParser.parse("看：\n```\nfoo"), [.paragraph("看："), .code(language: nil, text: "foo")])
    }

    func testHashWithoutSpaceIsParagraph() {
        XCTAssertEqual(MarkdownParser.parse("#tag"), [.paragraph("#tag")])
    }
}
