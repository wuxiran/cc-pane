import XCTest
@testable import CCPanes

final class MirrorPresentationTests: XCTestCase {
    private let footer = ["", String(repeating: "─", count: 40), "❯", String(repeating: "─", count: 40),
                          "  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← 1 agent"]

    func testPreviewSkipsClaudeFooterNoise() {
        let lines = ["⏺ Bash(ls)", "", "✻ Julienning… (6m 26s · ↓ 3.5k tokens)"] + footer
        XCTAssertEqual(meaningfulPreview(lines), "Julienning… (6m 26s · ↓ 3.5k tokens)")
    }

    func testPreviewJoinsWrappedRecapAndDropsConfigHint() {
        let lines = ["※ recap: 在清 Mac 磁盘，现在有 73G 可用。下一步等你回\"做\"。 (turn",
                     "  off recaps in /config)"] + footer
        XCTAssertEqual(meaningfulPreview(lines), "在清 Mac 磁盘，现在有 73G 可用。下一步等你回\"做\"。")
    }

    func testPreviewAllNoiseIsNil() {
        XCTAssertNil(meaningfulPreview(footer))
        XCTAssertNil(meaningfulPreview([]))
    }

    func testCleanTitleStripsCliSuffix() {
        XCTAssertEqual(cleanSessionTitle("cc-pane (Claude)"), "cc-pane")
        XCTAssertEqual(cleanSessionTitle("vms (Claude) (1)"), "vms (1)")
        XCTAssertEqual(cleanSessionTitle("Terminal"), "Terminal")
        XCTAssertEqual(cleanSessionTitle("(Codex)"), "(Codex)")
    }

    func testLayoutShapeOrdinalsFollowPanelOrder() {
        func panel(_ id: String) -> PaneNode { .panel(id: id, activeTabId: nil, tabs: []) }
        let root: PaneNode = .split([panel("a"), .split([panel("b"), panel("c")], horizontal: false, sizes: [60, 40])],
                                    horizontal: true, sizes: [50, 50])
        let shape = layoutShape(root)
        XCTAssertEqual(shape, .split(horizontal: true, children: [
            .pane(ordinal: 1),
            .split(horizontal: false, children: [.pane(ordinal: 2), .pane(ordinal: 3)], weights: [60, 40]),
        ], weights: [50, 50]))
        XCTAssertEqual(shape?.paneCount, 3)
        XCTAssertEqual(collectPanels(root).map(\.id), ["a", "b", "c"])
    }

    func testLayoutShapeEqualWeightsWhenSizesMissing() {
        let root: PaneNode = .split([.panel(id: "a", activeTabId: nil, tabs: []), .panel(id: "b", activeTabId: nil, tabs: [])])
        XCTAssertEqual(layoutShape(root), .split(horizontal: true, children: [.pane(ordinal: 1), .pane(ordinal: 2)], weights: [1, 1]))
    }

    func testSplitDirectionDecodes() throws {
        let json = #"{"type":"split","direction":"vertical","sizes":[30,70],"children":[{"id":"a","tabs":[]},{"id":"b","tabs":[]}]}"#
        let node = try JSONDecoder().decode(PaneNode.self, from: Data(json.utf8))
        XCTAssertEqual(layoutShape(node), .split(horizontal: false, children: [.pane(ordinal: 1), .pane(ordinal: 2)], weights: [30, 70]))
    }

    func testPhaseMappingAndCounts() {
        XCTAssertEqual(SessionPhase(status: "waitingInput", exited: false), .waiting)
        XCTAssertEqual(SessionPhase(status: "toolRunning", exited: false), .running)
        XCTAssertEqual(SessionPhase(status: "idle", exited: false), .idle)
        XCTAssertEqual(SessionPhase(status: "idle", exited: true), .exited)
        let counts = PhaseCounts([.idle, .waiting, .running, .running])
        XCTAssertEqual(counts.top, .waiting)
        XCTAssertEqual(counts.total, 4)
        XCTAssertNil(PhaseCounts().top)
    }

    func testLooseISO8601ParsesMicroseconds() {
        XCTAssertNotNil(parseLooseISO8601("2026-11-27T09:59:00.649625+00:00"))
        XCTAssertNotNil(parseLooseISO8601("2026-11-27T10:38:45.746Z"))
    }
}
