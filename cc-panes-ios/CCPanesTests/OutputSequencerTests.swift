import XCTest
@testable import CCPanes

final class OutputSequencerTests: XCTestCase {
    typealias Frame = OutputSequencer.OutputFrame

    func testBufferedFramesCoveredBySnapshotAreDropped() {
        var s = OutputSequencer()
        XCTAssertNil(s.accept(Frame(data: "abc", endSeq: 3)))
        XCTAssertNil(s.accept(Frame(data: "def", endSeq: 6)))
        XCTAssertEqual(s.snapshotApplied(endSeq: 6), "")
    }

    func testStraddlingFrameIsTrimmed() {
        var s = OutputSequencer()
        _ = s.accept(Frame(data: "abcdef", endSeq: 6))
        XCTAssertEqual(s.snapshotApplied(endSeq: 4), "ef")
    }

    func testLiveFramesAfterSnapshotPassAndDuplicatesDrop() {
        var s = OutputSequencer()
        XCTAssertEqual(s.snapshotApplied(endSeq: 10), "")
        XCTAssertEqual(s.accept(Frame(data: "xy", endSeq: 12)), "xy")
        XCTAssertNil(s.accept(Frame(data: "xy", endSeq: 12)))
        XCTAssertEqual(s.accept(Frame(data: "z", endSeq: 13)), "z")
    }

    func testTrimRespectsUtf8Boundary() {
        // "中" 是 3 字节；快照恰好截在它中间时不能吐出半个字符
        let frame = Frame(data: "a中b", endSeq: 5)
        XCTAssertEqual(OutputSequencer.trim(frame, after: 2, buffered: true), "b")
        XCTAssertEqual(OutputSequencer.trim(frame, after: 1, buffered: true), "中b")
    }

    func testLegacySnapshotWithoutSeqDropsBufferAndPassesLive() {
        var s = OutputSequencer()
        _ = s.accept(Frame(data: "old", endSeq: nil))
        XCTAssertEqual(s.snapshotApplied(endSeq: nil), "")
        XCTAssertEqual(s.accept(Frame(data: "new", endSeq: nil)), "new")
    }

    func testServerURLNormalization() {
        XCTAssertEqual(AppModel.normalize("192.168.1.2:18080/")?.absoluteString, "http://192.168.1.2:18080")
        XCTAssertNil(AppModel.normalize("ftp://x"))
    }
}

final class DirectRouteTests: XCTestCase {
    func testLocalHostsBypassProxy() {
        for s in ["http://127.0.0.1:18080", "http://192.168.1.5", "http://10.0.0.2", "http://172.20.1.1", "http://mac.local", "http://100.101.2.3"] {
            XCTAssertTrue(DirectRoute.isLocal(URL(string: s)!), s)
        }
        for s in ["https://host.ts.net", "http://8.8.8.8", "http://172.32.0.1"] {
            XCTAssertFalse(DirectRoute.isLocal(URL(string: s)!), s)
        }
    }
}
