import Foundation
import Observation

/// 本地数据落盘：`Application Support/CCPanesLocal/`（不用 UserDefaults——对话可能很大）。
/// 文件保护 `completeUntilFirstUserAuthentication`，原子写。
enum LocalStorage {
    static func defaultRoot(_ name: String = "CCPanesLocal") -> URL {
        let base = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                  appropriateFor: nil, create: true))
            ?? FileManager.default.temporaryDirectory
        return base.appending(path: name, directoryHint: .isDirectory)
    }

    static func ensureDirectory(_ url: URL) {
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()

    static func write<T: Encodable>(_ value: T, to url: URL) throws {
        ensureDirectory(url.deletingLastPathComponent())
        let data = try encoder.encode(value)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    static func read<T: Decodable>(_ type: T.Type, from url: URL) -> T? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? decoder.decode(type, from: data)
    }
}

/// 本机供应商：元数据在 `providers.json`，API Key 只在 Keychain
/// （service `com.ccpanes.ios.llm-key`，account = 供应商 id，`AfterFirstUnlockThisDeviceOnly`，不随备份迁移）。
@MainActor
@Observable
final class LocalProviderStore {
    static let keychainService = "com.ccpanes.ios.llm-key"

    private(set) var providers: [LocalProvider] = []
    /// 有密钥的供应商 id（避免每次渲染读 Keychain）。
    private(set) var keyed: Set<String> = []
    private(set) var lastError: String?

    @ObservationIgnored let fileURL: URL
    @ObservationIgnored private let secrets: any SecretStore

    init(directory: URL = LocalStorage.defaultRoot(),
         secrets: any SecretStore = KeychainSecretStore(service: LocalProviderStore.keychainService)) {
        fileURL = directory.appending(path: "providers.json")
        self.secrets = secrets
        reload()
    }

    struct FileFormat: Codable {
        var version = 1
        var providers: [LocalProvider]
    }

    func reload() {
        providers = LocalStorage.read(FileFormat.self, from: fileURL)?.providers ?? []
        keyed = Set(providers.map(\.id).filter { (try? secrets.read(account: $0))??.isEmpty == false })
    }

    func provider(_ id: String) -> LocalProvider? { providers.first { $0.id == id } }

    func hasKey(_ id: String) -> Bool { keyed.contains(id) }

    /// 读密钥（发请求前调用）。不缓存在内存里。
    func apiKey(for id: String) -> String? {
        guard let value = try? secrets.read(account: id), !value.isEmpty else { return nil }
        return value
    }

    /// 新增 / 更新。`apiKey == nil` 表示不改密钥；空串表示清除。
    func save(_ provider: LocalProvider, apiKey: String? = nil) throws {
        var provider = provider
        provider.name = provider.name.trimmingCharacters(in: .whitespacesAndNewlines)
        provider.baseURL = provider.baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        provider.updatedAt = .now
        if let apiKey {
            let trimmed = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                try secrets.delete(account: provider.id)
                keyed.remove(provider.id)
            } else {
                try secrets.write(trimmed, account: provider.id)
                keyed.insert(provider.id)
            }
        }
        var next = providers
        if let index = next.firstIndex(where: { $0.id == provider.id }) { next[index] = provider } else { next.append(provider) }
        try persist(next)
    }

    func delete(_ id: String) {
        try? secrets.delete(account: id)
        keyed.remove(id)
        try? persist(providers.filter { $0.id != id })
    }

    struct ImportSummary: Equatable, Sendable {
        var added: [String] = []
        var updated: [String] = []
        /// (名称, 中文原因)
        var skipped: [Skipped] = []

        struct Skipped: Equatable, Sendable {
            var name: String
            var reason: String
        }
    }

    /// 写入从电脑导出的供应商：同一台电脑的同一条（`originId`）覆盖，否则新增；密钥进 Keychain。
    func importPayload(_ payload: ProviderExportPayload, computerName: String) throws -> ImportSummary {
        var summary = ImportSummary()
        var next = providers
        for exported in payload.providers {
            guard let kind = LLMProtocol(rawValue: exported.protocolKind) else {
                summary.skipped.append(.init(name: exported.name, reason: "手机暂不支持该协议"))
                continue
            }
            let existing = next.firstIndex { $0.originId == exported.id && $0.sourceComputer == computerName }
            let id = existing.map { next[$0].id } ?? UUID().uuidString
            let provider = LocalProvider(
                id: id, name: exported.name, kind: kind, baseURL: exported.baseUrl,
                models: exported.models.map { LocalModel(id: $0.id, label: $0.label) },
                defaultModelId: exported.defaultModelId, sourceComputer: computerName,
                originId: exported.id)
            try secrets.write(exported.apiKey, account: id)
            keyed.insert(id)
            if let existing {
                next[existing] = provider
                summary.updated.append(exported.name)
            } else {
                next.append(provider)
                summary.added.append(exported.name)
            }
        }
        summary.skipped += payload.skipped.map { .init(name: $0.name, reason: ProviderExportPayload.reasonLabel($0.reason)) }
        try persist(next)
        return summary
    }

    private func persist(_ next: [LocalProvider]) throws {
        do {
            try LocalStorage.write(FileFormat(providers: next), to: fileURL)
            providers = next
            lastError = nil
        } catch {
            lastError = "保存供应商失败：\(error.localizedDescription)"
            throw error
        }
    }
}
