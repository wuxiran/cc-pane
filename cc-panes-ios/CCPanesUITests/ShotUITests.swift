import XCTest

/// 截图辅助（非回归测试）：真实手势下滑，验证 iOS 26 tab 栏收起 + 底部状态条并排。
/// 运行：xcodebuild test -scheme CCPanesUIShots …；截图写到环境变量 `SHOT_DIR`（默认 /tmp）。
final class ShotUITests: XCTestCase {
    func testMinimizedTabBar() throws {
        let app = XCUIApplication()
        let dir = ProcessInfo.processInfo.environment["SHOT_DIR"] ?? NSTemporaryDirectory()
        let address = ProcessInfo.processInfo.environment["SHOT_ADDRESS"] ?? "http://127.0.0.1:18081"
        for appearance in ["dark", "light"] {
            app.launchArguments = ["-directAddress", address, "-directOnly", "YES", "-acpMock", "YES",
                                   "-mockMirror", "YES", "-mockContacts", "YES", "-initialTab", "terminal",
                                   "-appearance", appearance]
            app.launch()
            sleep(6)
            app.swipeUp(velocity: .slow)
            sleep(2)
            let png = XCUIScreen.main.screenshot().pngRepresentation
            try png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("minimized-\(appearance).png"))
        }
    }

    /// 「终端」tab 内容区左右滑翻布局：左滑到下一页、纵向滚动不翻页，截图带页码。
    func testLayoutPaging() throws {
        let app = XCUIApplication()
        let dir = ProcessInfo.processInfo.environment["SHOT_DIR"] ?? NSTemporaryDirectory()
        let address = ProcessInfo.processInfo.environment["SHOT_ADDRESS"] ?? "http://127.0.0.1:18081"
        app.launchArguments = ["-directAddress", address, "-directOnly", "YES", "-mockMirror", "YES",
                               "-initialTab", "terminal", "-appearance", "dark"]
        app.launch()
        let header = app.buttons.matching(NSPredicate(format: "label BEGINSWITH '切换布局'")).firstMatch
        XCTAssertTrue(header.waitForExistence(timeout: 10))
        XCTAssertTrue(header.label.contains("第 1/"), header.label)
        let content = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.55))
        // 纵向滚动不翻页
        content.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.52, dy: 0.3)))
        sleep(1)
        XCTAssertTrue(header.label.contains("第 1/"), header.label)
        // 左滑 → 第 2 页
        content.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.56)))
        sleep(1)
        XCTAssertTrue(header.label.contains("第 2/"), header.label)
        try XCUIScreen.main.screenshot().pngRepresentation
            .write(to: URL(fileURLWithPath: dir).appendingPathComponent("paging-swiped-dark.png"))
        // 右滑两次 → 回第 1 页、再到「全部」页（无页码）
        for _ in 0..<2 {
            content.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.56)))
            sleep(1)
        }
        XCTAssertEqual(header.label.contains("第 "), false, header.label)
        try XCUIScreen.main.screenshot().pngRepresentation
            .write(to: URL(fileURLWithPath: dir).appendingPathComponent("paging-all-dark.png"))
    }
}
