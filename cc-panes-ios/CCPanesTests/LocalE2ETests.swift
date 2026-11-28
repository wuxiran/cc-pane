import XCTest
@testable import CCPanes

/// 本机 dev 桌面（18081）上的导入 E2E 辅助（docs/112 §6）。默认全部跳过；只在带环境变量时运行：
/// `xcodebuild test … TEST_RUNNER_LOCAL_E2E_STEP=seed TEST_RUNNER_LOCAL_E2E_TOKEN=ccp_dev_…`
/// - `seed`：把地址簿里 18081 那台电脑标成「已配对」（设备令牌进 Keychain），供 UI 导入流程使用
/// - `verify`：核对导入结果——密钥在 Keychain（`LOCAL_E2E_EXPECT_KEY`）、`providers.json` 无密钥；随后删除导入的条目
/// - `unseed`：撤销 seed（删令牌、去掉 tokenAccount）
/// 令牌 / 密钥只经环境变量传入，断言失败信息里不回显。
@MainActor
final class LocalE2ETests: XCTestCase {
    private let env = ProcessInfo.processInfo.environment
    private let address = "http://127.0.0.1:18081"

    private func step(_ name: String) throws {
        guard env["LOCAL_E2E_STEP"] == name else { throw XCTSkip("LOCAL_E2E_STEP != \(name)") }
    }

    func testSeedPairedDevComputer() throws {
        try step("seed")
        let token = try XCTUnwrap(env["LOCAL_E2E_TOKEN"], "需要 LOCAL_E2E_TOKEN")
        let store = ComputerBookStore()
        var loaded = store.load()
        let index = try XCTUnwrap(loaded.computers.firstIndex { $0.addresses.contains(address) }, "地址簿里没有 18081")
        let id = loaded.computers[index].id
        try TokenVault.live.save(token, for: id)
        loaded.computers[index].tokenAccount = id
        loaded.computers[index].name = "dev-mac (18081)"
        store.save(loaded.computers, currentId: loaded.currentId)
        XCTAssertTrue(TokenVault.live.token(for: id) == token)
    }

    func testVerifyImportedProvider() throws {
        try step("verify")
        let expected = try XCTUnwrap(env["LOCAL_E2E_EXPECT_KEY"])
        let store = LocalProviderStore() // 真实目录 + 真实 Keychain（与 App 同一份）
        let imported = try XCTUnwrap(store.providers.first { $0.originId == env["LOCAL_E2E_PROVIDER_ID"] }, "没有导入的条目")
        XCTAssertNotNil(imported.sourceComputer)
        XCTAssertEqual(imported.kind, .anthropic)
        XCTAssertEqual(imported.defaultModelId, "claude-e2e-model")
        XCTAssertTrue(store.hasKey(imported.id))
        XCTAssertTrue(store.apiKey(for: imported.id) == expected, "Keychain 里的密钥与导出的不一致")
        // 直接用 Security 框架再读一次，确认就在 com.ccpanes.ios.llm-key 这个 service 下
        let raw = try KeychainSecretStore(service: LocalProviderStore.keychainService).read(account: imported.id)
        XCTAssertTrue(raw == expected)
        let file = try String(contentsOf: store.fileURL, encoding: .utf8)
        XCTAssertFalse(file.contains(expected), "providers.json 不得含密钥")
        XCTAssertTrue(file.contains(imported.name))
        print("E2E_VERIFY_OK providersFile=\(store.fileURL.path()) providerId=\(imported.id) keychainService=\(LocalProviderStore.keychainService)")
        if env["LOCAL_E2E_KEEP"] != "1" {
            store.delete(imported.id)
            XCTAssertNil(try KeychainSecretStore(service: LocalProviderStore.keychainService).read(account: imported.id))
        }
    }

    func testUnseedPairedDevComputer() throws {
        try step("unseed")
        let store = ComputerBookStore()
        var loaded = store.load()
        guard let index = loaded.computers.firstIndex(where: { $0.addresses.contains(address) }) else { return }
        TokenVault.live.remove(loaded.computers[index].id)
        loaded.computers[index].tokenAccount = nil
        loaded.computers[index].name = "127.0.0.1"
        store.save(loaded.computers, currentId: loaded.currentId)
    }
}
