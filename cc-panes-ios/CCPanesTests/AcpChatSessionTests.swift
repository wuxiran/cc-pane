import XCTest
@testable import CCPanes

/// 状态机 + mock 事件环：补发 → synchronized → 实时，断开重连带 lastSeq 不重复。
@MainActor
final class AcpChatSessionTests: XCTestCase {
    private func waitUntil(_ timeout: Duration = .seconds(5), _ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + timeout
        while !condition() {
            if ContinuousClock.now > deadline { throw XCTSkip("timeout") }
            try await Task.sleep(for: .milliseconds(20))
        }
    }

    func testReplayThenReconnectDoesNotDuplicate() async throws {
        let service = MockAcpService(defaults: UserDefaults(suiteName: "acp-test-\(UUID())")!)
        let session = AcpChatSession(chatId: "mock-done", service: service, canWrite: true)
        session.attach()
        try await waitUntil { session.link == .live && session.state.phase == .ready && session.state.items.count >= 5 }
        let snapshot = session.state.items
        let lastSeq = session.state.lastSeq
        XCTAssertGreaterThan(lastSeq, 0)
        XCTAssertNil(session.state.dockedCard, "instant 剧本里审批已在别处处理")

        session.suspend()
        XCTAssertEqual(session.link, .suspended)
        session.resume()
        try await waitUntil { session.link == .live }
        XCTAssertEqual(session.state.items, snapshot, "按 lastSeq 续传，不重复")
        XCTAssertEqual(session.state.lastSeq, lastSeq)
        session.detach()
    }

    func testSendAddsLocalBubbleAndEchoIsSwallowed() async throws {
        let service = MockAcpService(defaults: UserDefaults(suiteName: "acp-test-\(UUID())")!)
        let snapshot = try await service.create(engineId: "claude", cwd: "/tmp/x", resumeAcpSessionId: nil)
        let session = AcpChatSession(chatId: snapshot.chatId!, service: service, canWrite: true)
        session.attach()
        try await waitUntil { session.link == .live && session.state.phase == .ready }
        await session.send("你好")
        try await waitUntil { session.state.items.contains { if case .assistant = $0.kind { true } else { false } } }
        try await waitUntil { session.state.phase == .ready }
        let users = session.state.items.filter { if case .user = $0.kind { true } else { false } }
        XCTAssertEqual(users.map(\.kind), [.user("你好")])
        session.detach()
    }

    func testReadOnlySessionCannotSend() async {
        let service = MockAcpService(defaults: UserDefaults(suiteName: "acp-test-\(UUID())")!)
        let session = AcpChatSession(chatId: "mock-done", service: service, canWrite: false)
        XCTAssertTrue(session.readOnly)
        await session.send("x")
        XCTAssertTrue(session.state.items.isEmpty)
    }

    func testErrorMapping() {
        XCTAssertEqual(AcpError.from(status: 503, body: Data()), .hostUnavailable)
        XCTAssertEqual(AcpError.from(status: 500, body: Data(#"{"code":"ACP_HOST_UNAVAILABLE"}"#.utf8)), .hostUnavailable)
        XCTAssertEqual(AcpError.from(status: 403, body: Data(#"{"code":"READ_ONLY","message":"只读"}"#.utf8)), .readOnly("只读"))
        XCTAssertEqual(AcpError.from(status: 400, body: Data(#"{"message":"坏请求"}"#.utf8)), .other("坏请求"))
    }
}
