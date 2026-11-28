import Foundation
import Security

/// 机密存储抽象：真机 / 模拟器走 Keychain，单测注入内存实现。
protocol SecretStore: Sendable {
    func read(account: String) throws -> String?
    func write(_ value: String, account: String) throws
    func delete(account: String) throws
}

enum SecretStoreError: LocalizedError, Equatable {
    case keychain(OSStatus)

    var errorDescription: String? {
        switch self {
        case .keychain(let status): "钥匙串操作失败（\(status)）"
        }
    }
}

/// Keychain 实现：kSecClassGenericPassword，service 固定、account = 电脑 id。
/// 可访问性 AfterFirstUnlockThisDeviceOnly：后台重连可读，且不随备份迁移到别的设备。
struct KeychainSecretStore: SecretStore {
    var service = "com.ccpanes.ios.device-token"

    func baseQuery(account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    /// 新增条目时的完整属性（单测核对可访问性）。
    func addAttributes(_ value: String, account: String) -> [String: Any] {
        var query = baseQuery(account: account)
        query[kSecValueData as String] = Data(value.utf8)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return query
    }

    func read(account: String) throws -> String? {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw SecretStoreError.keychain(status) }
        return (result as? Data).flatMap { String(data: $0, encoding: .utf8) }
    }

    func write(_ value: String, account: String) throws {
        let update: [String: Any] = [
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(baseQuery(account: account) as CFDictionary, update as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw SecretStoreError.keychain(status) }
        let added = SecItemAdd(addAttributes(value, account: account) as CFDictionary, nil)
        guard added == errSecSuccess else { throw SecretStoreError.keychain(added) }
    }

    func delete(account: String) throws {
        let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw SecretStoreError.keychain(status) }
    }
}

/// 内存实现（单测 / 预览）。
final class MemorySecretStore: SecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]

    init(_ initial: [String: String] = [:]) { values = initial }

    var all: [String: String] { lock.withLock { values } }

    func read(account: String) throws -> String? { lock.withLock { values[account] } }
    func write(_ value: String, account: String) throws { lock.withLock { values[account] = value } }
    func delete(account: String) throws { lock.withLock { values[account] = nil } }
}

/// 设备令牌保管：按电脑 id 存取 `ccp_dev_…`。
struct TokenVault: Sendable {
    let store: any SecretStore

    static let live = TokenVault(store: KeychainSecretStore())

    func token(for computerId: String) -> String? {
        (try? store.read(account: computerId)).flatMap { $0?.isEmpty == false ? $0 : nil }
    }

    func save(_ token: String, for computerId: String) throws {
        try store.write(token, account: computerId)
    }

    func remove(_ computerId: String) {
        try? store.delete(account: computerId)
    }
}
