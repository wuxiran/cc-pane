import Foundation
import Observation
import UIKit

/// 全局连接状态：电脑地址簿 + 当前电脑 + 鉴权结果。
/// 非机密元数据存 UserDefaults（ComputerBookStore），设备令牌存 Keychain（TokenVault）。
@MainActor
@Observable
final class AppModel {
    enum State: Equatable {
        case disconnected
        case connecting
        case needsLogin
        case connected
        /// 设备令牌被拒（吊销 / 过期）：回连接页并引导重新配对。
        case tokenRejected
        case failed(String)
    }

    enum Reachability: Equatable { case unknown, checking, online, offline }

    private(set) var state: State = .disconnected
    private(set) var api: APIClient?
    private(set) var auth: AuthStatus?
    private(set) var computers: [Computer] = []
    private(set) var currentId: String?
    /// 在线状态点（电脑 id → 可达性）。
    private(set) var reachability: [String: Reachability] = [:]
    /// 配对进行中 / 最近一次配对错误（已连接时配对失败不打断当前连接）。
    private(set) var pairingBusy = false
    private(set) var pairError: String?
    /// 连接页「直连」输入框。
    var serverURL: String

    @ObservationIgnored let store: ComputerBookStore
    @ObservationIgnored let vault: TokenVault
    @ObservationIgnored private let probe: AddressProbe.Probe
    /// 所有「保持连接」电脑的常驻连接（首页数据源）。`currentId` 只剩「连接页默认选中」的意义。
    let hub: ConnectionHub

    init(store: ComputerBookStore = ComputerBookStore(), vault: TokenVault = .live,
         probe: @escaping AddressProbe.Probe = AddressProbe.healthProbe) {
        self.store = store
        self.vault = vault
        self.probe = probe
        hub = ConnectionHub(vault: vault, probe: probe)
        let loaded = store.load()
        computers = loaded.computers
        currentId = loaded.currentId
        serverURL = loaded.computers.first { $0.id == loaded.currentId }?.addresses.first ?? "http://127.0.0.1:18080"
        hub.onInfo = { [weak self] id, url, info in self?.recordInfo(id, url: url, info: info) }
        hub.sync(computers)
    }

    /// 地址簿非空即进首页（多电脑同时在线）；直连时服务端要求登录则留在连接页完成登录。
    var showsHome: Bool { (!computers.isEmpty || localOnly) && state != .needsLogin }

    /// 不连电脑、只用本机模型（docs/112 §6）：连接页「先在本机使用」打开；调试 `-localMock YES` 时默认打开。
    var localOnly: Bool = UserDefaults.standard.bool(forKey: "ccpanes.localOnly")
        || UserDefaults.standard.bool(forKey: "localMock") {
        didSet { UserDefaults.standard.set(localOnly, forKey: "ccpanes.localOnly") }
    }

    func setKeepConnected(_ id: String, _ on: Bool) {
        guard var computer = computers.first(where: { $0.id == id }) else { return }
        computer.keepConnected = on
        replace(computer)
    }

    /// 调试：`-directAddress a,b` 把多个地址各记成一台电脑（免登录服务端），由 hub 同时连接。
    func addDirect(_ addresses: [String]) {
        for raw in addresses {
            guard let url = AddressBook.normalize(raw) else { continue }
            var computer = upsert(address: url.absoluteString, name: url.host() ?? "电脑", token: nil)
            if computer.keepConnected == false {
                computer.keepConnected = true
                replace(computer)
            }
        }
        // 调试：`-directOnly YES` 只保持这几台连接（地址簿里其他电脑暂停），截图 / 联调用
        if UserDefaults.standard.bool(forKey: "directOnly") {
            let keep = Set(addresses.compactMap { AddressBook.normalize($0)?.absoluteString })
            for var computer in computers where !computer.addresses.contains(where: keep.contains) && computer.isEnabled {
                computer.keepConnected = false
                replace(computer)
            }
        }
        if state != .connected { state = .connected }
    }

    var canWrite: Bool { auth?.canWrite ?? false }
    var current: Computer? { computers.first { $0.id == currentId } }

    // MARK: - Connect

    /// 连当前电脑：并发探测全部地址择优（局域网领跑），带令牌则走 Bearer。
    func connect() async {
        guard let computer = current else { return await connectDirect() }
        state = .connecting
        reachability[computer.id] = .checking
        guard let url = await AddressProbe.pickBest(computer.addresses, probe: probe) else {
            reachability[computer.id] = .offline
            state = .failed("「\(computer.name)」不在线（已尝试 \(computer.addresses.count) 个地址）")
            return
        }
        reachability[computer.id] = .online
        let token = computer.tokenAccount.flatMap(vault.token(for:))
        if computer.isPaired && token == nil {
            state = .tokenRejected
            return
        }
        await open(url, token: token, computerId: computer.id)
    }

    /// 「直连」：按输入地址连接（Cookie 登录 / 免登录），地址并入地址簿。
    func connectDirect() async {
        guard let url = AddressBook.normalize(serverURL) else {
            state = .failed("地址无效")
            return
        }
        serverURL = url.absoluteString
        let computer = upsert(address: url.absoluteString, name: url.host() ?? "电脑", token: nil)
        state = .connecting
        await open(url, token: computer.tokenAccount.flatMap(vault.token(for:)), computerId: computer.id)
    }

    private func open(_ url: URL, token: String?, computerId: String) async {
        let client = APIClient(baseURL: url, token: token) { [weak self] in
            Task { @MainActor in self?.handleTokenRejected() }
        }
        do {
            let status = try await client.authStatus()
            // /api/auth/status 免鉴权：带了令牌却未认证 = 令牌已失效。
            if token != nil && !status.authenticated {
                state = .tokenRejected
                return
            }
            api = client
            auth = status
            touch(computerId, address: url.absoluteString)
            state = status.authenticated ? .connected : .needsLogin
            if status.authenticated { await hub.reconnect(computerId) }
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    func login(username: String, password: String) async {
        guard let api else { return }
        do {
            try await api.login(username: username, password: password)
            let status = try await api.authStatus()
            auth = status
            state = status.authenticated ? .connected : .failed("登录失败")
            if status.authenticated, let id = currentId { await hub.reconnect(id) }
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    func disconnect() {
        api = nil
        auth = nil
        state = .disconnected
    }

    private func handleTokenRejected() {
        guard state == .connected || state == .connecting else { return }
        api = nil
        auth = nil
        state = .tokenRejected
    }

    // MARK: - Pairing

    /// 配对码换令牌 → Keychain → 拉设备名 → 设为当前电脑并连接。
    func pair(address: String, code: String) async {
        pairError = nil
        guard let url = AddressBook.normalize(address) else { return failPairing(PairingError.invalidAddress) }
        pairingBusy = true
        defer { pairingBusy = false }
        do {
            let result = try await DevicePairing.pair(baseURL: url, code: code, deviceName: UIDevice.current.name)
            var computer = upsert(address: url.absoluteString, name: result.hostname ?? url.host() ?? "电脑", token: nil)
            try vault.save(result.token, for: computer.id)
            computer.tokenAccount = computer.id
            replace(computer)
            state = .connecting
            await open(url, token: result.token, computerId: computer.id)
        } catch {
            failPairing(error)
        }
    }

    private func failPairing(_ error: Error) {
        pairError = error.localizedDescription
        if state != .connected { state = .failed(error.localizedDescription) }
    }

    // MARK: - Address book

    func switchTo(_ id: String) async {
        guard computers.contains(where: { $0.id == id }) else { return }
        currentId = id
        persist()
        disconnect()
        await connect()
    }

    func rename(_ id: String, to name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, var computer = computers.first(where: { $0.id == id }) else { return }
        computer.name = trimmed
        replace(computer)
    }

    func remove(_ id: String) {
        guard let computer = computers.first(where: { $0.id == id }) else { return }
        if let account = computer.tokenAccount { vault.remove(account) }
        computers.removeAll { $0.id == id }
        reachability[id] = nil
        if currentId == id {
            currentId = computers.first?.id
            disconnect()
        }
        persist()
    }

    /// 给电脑加一条地址（如 Tailscale 100.x）；返回 false = 地址无效或已存在。
    @discardableResult
    func addAddress(_ id: String, _ raw: String) -> Bool {
        guard let url = AddressBook.normalize(raw), var computer = computers.first(where: { $0.id == id }),
              !computer.addresses.contains(url.absoluteString) else { return false }
        computer.addresses.append(url.absoluteString)
        replace(computer)
        return true
    }

    func removeAddress(_ id: String, _ address: String) {
        guard var computer = computers.first(where: { $0.id == id }), computer.addresses.count > 1 else { return }
        computer.addresses.removeAll { $0 == address }
        replace(computer)
    }

    /// 探测所有电脑的在线状态（任一地址 /api/health 通即在线）。
    func refreshReachability() async {
        let probe = self.probe
        await withTaskGroup(of: (String, Bool).self) { group in
            for computer in computers {
                reachability[computer.id] = .checking
                let addresses = computer.addresses
                group.addTask { (computer.id, await AddressProbe.pickBest(addresses, probe: probe) != nil) }
            }
            for await (id, ok) in group {
                reachability[id] = ok ? .online : .offline
                if ok { touch(id, address: nil) }
            }
        }
    }

    // MARK: - Plumbing

    /// 按地址找到已有电脑（重新配对复用同一条），找不到则新建；设为当前。
    @discardableResult
    private func upsert(address: String, name: String, token: String?) -> Computer {
        if var existing = computers.first(where: { $0.addresses.contains(address) }) {
            if existing.name.isEmpty { existing.name = name }
            currentId = existing.id
            replace(existing)
            return existing
        }
        let computer = Computer(name: name, addresses: [address])
        computers.append(computer)
        currentId = computer.id
        persist()
        return computer
    }

    private func replace(_ computer: Computer) {
        if let i = computers.firstIndex(where: { $0.id == computer.id }) { computers[i] = computer }
        persist()
    }

    private func touch(_ id: String, address: String?) {
        guard var computer = computers.first(where: { $0.id == id }) else { return }
        computer.lastSeen = Date()
        if let address { computer.lastAddress = address }
        replace(computer)
    }

    /// hub 连上一台电脑：记下机器名 / 实例 id / 开发版标记 / 线路，按 instanceId 去重。
    private func recordInfo(_ id: String, url: URL, info: DeviceInfo?) {
        reachability[id] = .online
        guard var computer = computers.first(where: { $0.id == id }) else { return }
        computer.lastSeen = Date()
        computer.lastAddress = url.absoluteString
        if let info {
            if let host = info.hostname, !host.isEmpty { computer.hostname = host }
            if let instance = info.instanceId, !instance.isEmpty { computer.instanceId = instance }
            computer.isDevInstance = ComputerNaming.isDev(info)
        }
        if let i = computers.firstIndex(where: { $0.id == id }) { computers[i] = computer }
        let merged = ComputerDedupe.merge(computers)
        if !merged.removed.isEmpty {
            let liveAccounts = Set(merged.computers.compactMap(\.tokenAccount))
            for removedId in merged.removed where !liveAccounts.contains(removedId) { vault.remove(removedId) }
            computers = merged.computers
            if let current = currentId, merged.removed.contains(current) { currentId = computers.first?.id }
        }
        persist()
    }

    private func persist() {
        store.save(computers, currentId: currentId)
        hub.sync(computers)
    }

    nonisolated static func normalize(_ raw: String) -> URL? { AddressBook.normalize(raw) }
}
