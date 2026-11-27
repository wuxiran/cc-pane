import XCTest
@testable import CCPanes

final class TerminalReplyFilterTests: XCTestCase {
    func testAutomaticRepliesAreDropped() {
        for reply in ["\u{1b}[?1;2c", "\u{1b}[>0;276;0c", "\u{1b}[12;40R", "\u{1b}[0n",
                      "\u{1b}[?2026;2$y", "\u{1b}[?0u", "\u{1b}]11;rgb:0000/0000/0000\u{07}",
                      "\u{1b}]10;rgb:ffff/ffff/ffff\u{1b}\\", "\u{1b}P>|SwiftTerm\u{1b}\\"] {
            XCTAssertTrue(TerminalReplyFilter.isAutomaticReply(reply), reply.debugDescription)
        }
    }

    func testUserKeysPass() {
        for key in ["a", "\r", "\u{1b}", "\u{1b}[A", "\u{1b}OB", "\u{1b}[15~", "\u{1b}[1;5D", "\u{03}", "中文"] {
            XCTAssertFalse(TerminalReplyFilter.isAutomaticReply(key), key.debugDescription)
        }
    }
}
