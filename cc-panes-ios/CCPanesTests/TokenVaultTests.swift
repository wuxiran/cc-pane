import Security
import XCTest
@testable import CCPanes

final class TokenVaultTests: XCTestCase {
    func testVaultStoresPerComputer() throws {
        let store = MemorySecretStore()
        let vault = TokenVault(store: store)
        try vault.save("ccp_dev_a", for: "pc-a")
        try vault.save("ccp_dev_b", for: "pc-b")
        XCTAssertEqual(vault.token(for: "pc-a"), "ccp_dev_a")
        XCTAssertEqual(vault.token(for: "pc-b"), "ccp_dev_b")
        try vault.save("ccp_dev_a2", for: "pc-a")
        XCTAssertEqual(vault.token(for: "pc-a"), "ccp_dev_a2", "重新配对覆盖旧令牌")
        vault.remove("pc-a")
        XCTAssertNil(vault.token(for: "pc-a"))
        XCTAssertEqual(store.all, ["pc-b": "ccp_dev_b"])
    }

    func testKeychainAttributes() {
        let store = KeychainSecretStore(service: "svc")
        let attrs = store.addAttributes("t", account: "pc")
        XCTAssertEqual(attrs[kSecClass as String] as? String, kSecClassGenericPassword as String)
        XCTAssertEqual(attrs[kSecAttrService as String] as? String, "svc")
        XCTAssertEqual(attrs[kSecAttrAccount as String] as? String, "pc")
        XCTAssertEqual(attrs[kSecAttrAccessible as String] as? String,
                       kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        XCTAssertEqual(attrs[kSecValueData as String] as? Data, Data("t".utf8))
    }

    /// 真 Keychain 往返（模拟器宿主 app 内可用；缺 entitlement 时跳过）。
    func testKeychainRoundTrip() throws {
        let store = KeychainSecretStore(service: "com.ccpanes.ios.tests.\(UUID())")
        do {
            try store.write("v1", account: "pc")
        } catch SecretStoreError.keychain(let status) where status == errSecMissingEntitlement {
            throw XCTSkip("模拟器无钥匙串 entitlement")
        }
        XCTAssertEqual(try store.read(account: "pc"), "v1")
        try store.write("v2", account: "pc")
        XCTAssertEqual(try store.read(account: "pc"), "v2")
        try store.delete(account: "pc")
        XCTAssertNil(try store.read(account: "pc"))
        try store.delete(account: "pc") // 幂等
    }
}
