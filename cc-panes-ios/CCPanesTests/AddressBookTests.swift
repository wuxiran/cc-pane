import XCTest
@testable import CCPanes

final class AddressBookTests: XCTestCase {
    func testKinds() {
        XCTAssertEqual(AddressBook.kind(of: "192.168.1.10:18080"), .lan)
        XCTAssertEqual(AddressBook.kind(of: "http://10.0.0.2"), .lan)
        XCTAssertEqual(AddressBook.kind(of: "http://172.20.1.1"), .lan)
        XCTAssertEqual(AddressBook.kind(of: "http://127.0.0.1:18080"), .lan)
        XCTAssertEqual(AddressBook.kind(of: "http://mac.local:18080"), .lan)
        XCTAssertEqual(AddressBook.kind(of: "http://100.101.102.103:18080"), .tailscale)
        XCTAssertEqual(AddressBook.kind(of: "https://mac.tail1234.ts.net"), .tailscale)
        XCTAssertEqual(AddressBook.kind(of: "http://100.20.0.1"), .other, "100.x 只有 64-127 段是 CGNAT")
        XCTAssertEqual(AddressBook.kind(of: "https://example.com"), .other)
    }

    func testOrderedPutsLanFirstAndKeepsInsertionOrder() {
        let list = ["http://100.64.0.1", "https://example.com", "http://192.168.1.2", "http://10.0.0.3"]
        XCTAssertEqual(AddressBook.ordered(list),
                       ["http://192.168.1.2", "http://10.0.0.3", "http://100.64.0.1", "https://example.com"])
    }

    // MARK: - 择优

    private static func fake(_ table: [String: (ms: Int, ok: Bool)]) -> AddressProbe.Probe {
        { url in
            let entry = table[url.absoluteString] ?? (0, false)
            try? await Task.sleep(for: .milliseconds(entry.ms))
            return entry.ok
        }
    }

    func testLanWinsWithinHeadStartEvenIfTailscaleIsFaster() async {
        let probe = Self.fake(["http://192.168.1.2": (300, true), "http://100.64.0.1": (5, true)])
        let best = await AddressProbe.pickBest(["http://100.64.0.1", "http://192.168.1.2"], probe: probe)
        XCTAssertEqual(best?.absoluteString, "http://192.168.1.2")
    }

    func testFallbackWinsWhenLanIsTooSlow() async {
        let probe = Self.fake(["http://192.168.1.2": (2000, true), "http://100.64.0.1": (5, true)])
        let start = ContinuousClock.now
        let best = await AddressProbe.pickBest(["http://192.168.1.2", "http://100.64.0.1"], probe: probe)
        XCTAssertEqual(best?.absoluteString, "http://100.64.0.1")
        XCTAssertLessThan(ContinuousClock.now - start, .milliseconds(1500))
    }

    func testFallbackStartsImmediatelyWhenLanFailsFast() async {
        let probe = Self.fake(["http://192.168.1.2": (0, false), "http://100.64.0.1": (5, true)])
        let start = ContinuousClock.now
        let best = await AddressProbe.pickBest(["http://192.168.1.2", "http://100.64.0.1"], headStart: .seconds(3), probe: probe)
        XCTAssertEqual(best?.absoluteString, "http://100.64.0.1")
        XCTAssertLessThan(ContinuousClock.now - start, .seconds(1), "局域网全挂不必等满领跑时间")
    }

    func testAllOfflineReturnsNil() async {
        let best = await AddressProbe.pickBest(["http://192.168.1.2", "http://100.64.0.1"], headStart: .milliseconds(50),
                                               probe: Self.fake([:]))
        XCTAssertNil(best)
        let none = await AddressProbe.pickBest([], probe: Self.fake([:]))
        XCTAssertNil(none)
    }

    // MARK: - 持久化 / 迁移

    private func freshDefaults() -> UserDefaults {
        UserDefaults(suiteName: "book-test-\(UUID())")!
    }

    func testMigratesLegacyServerURL() {
        let defaults = freshDefaults()
        defaults.set("http://192.168.1.10:18080/", forKey: ComputerBookStore.legacyServerKey)
        let loaded = ComputerBookStore(defaults: defaults).load()
        XCTAssertEqual(loaded.computers.count, 1)
        XCTAssertEqual(loaded.computers[0].addresses, ["http://192.168.1.10:18080"])
        XCTAssertEqual(loaded.computers[0].name, "192.168.1.10")
        XCTAssertFalse(loaded.computers[0].isPaired)
        XCTAssertEqual(loaded.currentId, loaded.computers[0].id)
        // 迁移只发生一次：再读得到同一条
        XCTAssertEqual(ComputerBookStore(defaults: defaults).load(), loaded)
    }

    func testRoundTripAndStaleCurrentId() {
        let defaults = freshDefaults()
        let store = ComputerBookStore(defaults: defaults)
        XCTAssertEqual(store.load(), .init(computers: []))
        let a = Computer(id: "a", name: "家里", addresses: ["http://192.168.1.2:18080", "http://100.64.0.1:18080"], tokenAccount: "a")
        let b = Computer(id: "b", name: "公司", addresses: ["http://10.0.0.2:18080"])
        store.save([a, b], currentId: "b")
        XCTAssertEqual(store.load(), .init(computers: [a, b], currentId: "b"))
        store.save([a], currentId: "gone")
        XCTAssertEqual(store.load().currentId, "a")
    }

    @MainActor
    func testAppModelRemoveDeletesKeychainItem() throws {
        let defaults = freshDefaults()
        let secrets = MemorySecretStore(["a": "ccp_dev_a"])
        let a = Computer(id: "a", name: "家里", addresses: ["http://192.168.1.2:18080"], tokenAccount: "a")
        let b = Computer(id: "b", name: "公司", addresses: ["http://10.0.0.2:18080"])
        ComputerBookStore(defaults: defaults).save([a, b], currentId: "a")
        let model = AppModel(store: ComputerBookStore(defaults: defaults), vault: TokenVault(store: secrets)) { _ in false }
        model.rename("b", to: "  公司 Mac  ")
        XCTAssertTrue(model.addAddress("b", "100.70.0.1:18080"))
        XCTAssertFalse(model.addAddress("b", "http://100.70.0.1:18080"), "重复地址")
        model.remove("a")
        XCTAssertTrue(secrets.all.isEmpty)
        XCTAssertEqual(model.currentId, "b")
        let reloaded = ComputerBookStore(defaults: defaults).load()
        XCTAssertEqual(reloaded.computers.map(\.name), ["公司 Mac"])
        XCTAssertEqual(reloaded.computers[0].addresses, ["http://10.0.0.2:18080", "http://100.70.0.1:18080"])
    }

    @MainActor
    func testConnectWithMissingTokenAsksForRepair() async {
        let defaults = freshDefaults()
        let a = Computer(id: "a", name: "家里", addresses: ["http://192.168.1.2:18080"], tokenAccount: "a")
        ComputerBookStore(defaults: defaults).save([a], currentId: "a")
        let model = AppModel(store: ComputerBookStore(defaults: defaults), vault: TokenVault(store: MemorySecretStore())) { _ in true }
        await model.connect()
        XCTAssertEqual(model.state, .tokenRejected)
    }

    @MainActor
    func testConnectOfflineComputer() async {
        let defaults = freshDefaults()
        ComputerBookStore(defaults: defaults).save([Computer(id: "a", name: "家里", addresses: ["http://192.168.1.2:18080"])], currentId: "a")
        let model = AppModel(store: ComputerBookStore(defaults: defaults), vault: TokenVault(store: MemorySecretStore())) { _ in false }
        await model.connect()
        XCTAssertEqual(model.reachability["a"], .offline)
        guard case .failed = model.state else { return XCTFail("\(model.state)") }
    }
}
