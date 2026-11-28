import Foundation
import Observation
import UIKit

/// 一台电脑的常驻连接：择优地址 + 鉴权 + 该电脑的列表模型（对话 / 工作区 / 镜像）。
/// 只做 REST；WebSocket 仍只在打开的对话 / 终端页上建立。
@MainActor
@Observable
final class ComputerLink: Identifiable {
    enum Status: Equatable {
        case connecting
        case online
        case offline
        /// 设备令牌被拒：需重新配对。
        case unauthorized
        /// 服务端要求账号密码（Cookie 登录未完成）。
        case needsLogin
        case failed(String)

        var isOnline: Bool { self == .online }

        var label: String {
            switch self {
            case .connecting: "连接中"
            case .online: "在线"
            case .offline: "离线"
            case .unauthorized: "令牌失效"
            case .needsLogin: "需要登录"
            case .failed: "连接失败"
            }
        }
    }

    let id: String
    private(set) var status: Status = .connecting
    private(set) var api: APIClient?
    private(set) var auth: AuthStatus?
    private(set) var via: AddressBook.Kind?
    /// `/api/device/info`（机器名、版本）。
    private(set) var info: DeviceInfo?
    private(set) var chats: ChatListModel?
    private(set) var workspaces: WorkspacesModel?
    private(set) var mirror: MirrorModel?
    /// 连续失败次数（退避用）与下次重试时间。
    private(set) var failures = 0
    private(set) var nextAttempt = Date.distantPast
    @ObservationIgnored private var connecting = false

    init(id: String) { self.id = id }

    var canWrite: Bool { auth?.canWrite ?? false }
    /// 这台电脑的 CC-Panes 还没有对话（ACP）接口。
    var chatsUnsupported: Bool { chats?.unsupported == true }
    /// 电脑可达，但桌面端 CC-Panes 没在运行（对话 503）。
    var hostDown: Bool { chats?.hostUnavailable == true }
    /// 已连上但最近一轮镜像拉取失败（网络抖动 / 电脑休眠）。
    var linkFailing: Bool { status == .online && mirror?.lastRefreshFailed == true }

    /// 退避：2s、4s、8s… 封顶 60s。
    nonisolated static func backoff(failures: Int) -> TimeInterval {
        min(60, 2 * pow(2, Double(max(0, failures - 1))))
    }

    func connect(_ computer: Computer, vault: TokenVault, probe: @escaping AddressProbe.Probe,
                 mocks: ConnectionHub.Mocks, onInfo: @escaping @MainActor (String, URL, DeviceInfo?) -> Void) async {
        guard !connecting else { return }
        connecting = true
        defer { connecting = false }
        if status != .online { status = .connecting }
        guard let url = await AddressProbe.pickBest(computer.addresses, probe: probe) else {
            fail(.offline)
            return
        }
        let token = computer.tokenAccount.flatMap(vault.token(for:))
        if computer.isPaired && token == nil { return fail(.unauthorized) }
        let id = self.id
        let client = APIClient(baseURL: url, token: token) { [weak self] in
            Task { @MainActor in self?.fail(.unauthorized) }
        }
        do {
            let auth = try await client.authStatus()
            if token != nil && !auth.authenticated { return fail(.unauthorized) }
            if !auth.authenticated { return fail(.needsLogin) }
            self.auth = auth
            via = AddressBook.kind(of: url)
            // 同一地址已在用就沿用模型（保留滚动 / 预览）；地址变了（局域网 ↔ Tailscale）才重建。
            if api?.baseURL != url || api?.token != token {
                api = client
                let chats = ChatListModel(service: mocks.acp && mocks.ownerId == id
                                          ? MockAcpService.shared : AcpClient(api: client))
                chats.computerId = id
                self.chats = chats
                workspaces = WorkspacesModel(api: client)
                mirror = MirrorModel(api: client, mock: mocks.mirror && mocks.ownerId == id)
            }
            status = .online
            failures = 0
            nextAttempt = .distantFuture
            info = try? await client.deviceInfo()
            onInfo(id, url, info)
        } catch {
            fail(.offline)
        }
    }

    /// 按 tab 刷新该电脑的数据。
    func refresh(_ parts: Set<ConnectionHub.Part>) async {
        guard status == .online else { return }
        await withTaskGroup(of: Void.self) { group in
            if parts.contains(.chats), let chats { group.addTask { await chats.reload() } }
            if parts.contains(.workspaces), let workspaces { group.addTask { await workspaces.reload() } }
            if parts.contains(.mirror), let mirror { group.addTask { await mirror.refresh() } }
        }
    }

    func markDue() { nextAttempt = .distantPast }

    private func fail(_ next: Status) {
        status = next
        failures += 1
        // 令牌失效 / 需要登录不自动重试（重试也是同样结果），等用户处理
        nextAttempt = (next == .unauthorized || next == .needsLogin)
            ? .distantFuture
            : Date().addingTimeInterval(Self.backoff(failures: failures))
    }
}

/// 所有「保持连接」电脑的常驻连接。按可见 tab 刷新：可见 tab 的数据 5s 一轮，
/// 角标所需数据（对话待审批、终端等待输入）30s 一轮，工作区只在可见时 30s 一轮；离线电脑指数退避重连。
@MainActor
@Observable
final class ConnectionHub {
    enum Part: Hashable, Sendable { case chats, workspaces, mirror }

    struct Mocks: Sendable {
        var acp = false
        var mirror = false
        /// mock 数据只挂在第一台电脑上，免得多台电脑各显示一份同样的样例。
        var ownerId: String?
    }

    private(set) var links: [ComputerLink] = []
    /// 电脑 id → 显示名（已去重）。
    private(set) var names: [String: String] = [:]
    private(set) var computers: [Computer] = []
    var visibleTab: HomeTab = .chat
    let contacts: ContactsModel

    @ObservationIgnored private let vault: TokenVault
    @ObservationIgnored private let probe: AddressProbe.Probe
    @ObservationIgnored private var mocks: Mocks
    @ObservationIgnored var onInfo: @MainActor (String, URL, DeviceInfo?) -> Void = { _, _, _ in }
    @ObservationIgnored private var tick = 0
    @ObservationIgnored private let mockAddress: String?

    init(vault: TokenVault, probe: @escaping AddressProbe.Probe, defaults: UserDefaults = .standard,
         contactsService: (any ContactsService)? = nil) {
        self.vault = vault
        self.probe = probe
        mocks = Mocks(acp: defaults.bool(forKey: "acpMock"), mirror: defaults.bool(forKey: "mockMirror"))
        // mock 优先挂在 `-directAddress` 的第一个地址那台电脑上
        mockAddress = defaults.string(forKey: "directAddress")?.split(separator: ",").first
            .flatMap { AddressBook.normalize(String($0))?.absoluteString }
        let box = HubBox()
        let service = contactsService ?? (defaults.bool(forKey: "mockContacts")
            ? MockContactsService.shared
            : LiveContactsService(resolver: { id in await MainActor.run { box.hub?.client(for: id) } },
                                  deviceName: UIDevice.current.name))
        contacts = ContactsModel(service: service)
        box.hub = self
    }

    var enabled: [Computer] { computers.filter(\.isEnabled) }

    func link(_ id: String) -> ComputerLink? { links.first { $0.id == id } }
    func name(_ id: String) -> String { names[id] ?? "电脑" }
    func computer(_ id: String) -> Computer? { computers.first { $0.id == id } }

    /// 地址簿变化：为「保持连接」的电脑建连接，关掉的 / 删掉的断开。
    func sync(_ computers: [Computer]) {
        self.computers = computers
        names = ComputerNaming.displayNames(computers)
        let wanted = computers.filter(\.isEnabled).map(\.id)
        if mocks.ownerId == nil || !wanted.contains(mocks.ownerId ?? "") {
            let preferred = computers.first { $0.isEnabled && mockAddress.map($0.addresses.contains) == true }
            mocks.ownerId = preferred?.id ?? wanted.first
        }
        let existing = Dictionary(uniqueKeysWithValues: links.map { ($0.id, $0) })
        links = wanted.map { existing[$0] ?? ComputerLink(id: $0) }
    }

    /// 常驻循环（HomeView 存活期间）。
    func run() async {
        while !Task.isCancelled {
            await cycle()
            try? await Task.sleep(for: .seconds(5))
        }
    }

    /// 一轮：到期的离线电脑重连；在线电脑刷新可见 tab 的数据。
    func cycle() async {
        tick += 1
        await reconnectDue()
        var parts = Self.parts(for: visibleTab)
        if tick % 6 == 1 { parts.formUnion([.chats, .mirror]) } // 角标数据 30s 兜底
        if visibleTab == .workspace, tick % 6 != 1 { parts.remove(.workspaces) }
        if tick == 1 { parts.insert(.workspaces) }
        let contactsEvery = visibleTab == .contacts || visibleTab == .search ? 2 : 6
        await refresh(parts, contacts: tick == 1 || tick % contactsEvery == 0)
    }

    /// 下拉刷新 / 回前台：立即重连所有离线电脑并刷新全部数据。
    func refreshAll() async {
        for link in links where !link.status.isOnline { link.markDue() }
        await reconnectDue()
        await refresh([.chats, .workspaces, .mirror], contacts: true)
    }

    func reconnect(_ id: String) async {
        guard let link = link(id), let computer = computer(id) else { return }
        link.markDue()
        await link.connect(computer, vault: vault, probe: probe, mocks: mocks, onInfo: onInfo)
        await link.refresh([.chats, .workspaces, .mirror])
    }

    nonisolated static func parts(for tab: HomeTab) -> Set<Part> {
        switch tab {
        case .chat: [.chats]
        case .contacts: []
        case .terminal: [.mirror]
        case .workspace: [.workspaces, .mirror]
        case .search: [.chats, .mirror]
        }
    }

    private func reconnectDue() async {
        let now = Date()
        let due = links.filter { !$0.status.isOnline && $0.nextAttempt <= now }
        let tasks = due.compactMap { link -> Task<Void, Never>? in
            guard let computer = computer(link.id) else { return nil }
            return Task { await link.connect(computer, vault: vault, probe: probe, mocks: mocks, onInfo: onInfo) }
        }
        for task in tasks { await task.value }
    }

    private func refresh(_ parts: Set<Part>, contacts includeContacts: Bool) async {
        var tasks = links.filter(\.status.isOnline).map { link in Task { await link.refresh(parts) } }
        if includeContacts {
            // 通讯录分组头用去重后的显示名
            let computers = enabled.map { computer in
                var named = computer
                named.name = name(computer.id)
                return named
            }
            let contacts = self.contacts
            tasks.append(Task { await contacts.reload(computers: computers, currentId: nil) })
        }
        for task in tasks { await task.value }
    }

    /// 通讯录取某台电脑的已连客户端（离线 = nil）。
    func client(for id: String) -> (APIClient, AddressBook.Kind)? {
        guard let link = link(id), link.status.isOnline, let api = link.api else { return nil }
        return (api, link.via ?? AddressBook.kind(of: api.baseURL))
    }

    // MARK: - 聚合

    var onlineCount: Int { links.filter(\.status.isOnline).count }
    /// 「保持连接」却连不上 / 被拒的电脑。
    var troubled: [ComputerLink] { links.filter { !$0.status.isOnline && $0.status != .connecting } }
    var chatPending: Int { links.reduce(0) { $0 + ($1.chats?.pendingNonBot ?? 0) } }
    var terminalWaiting: Int { links.reduce(0) { $0 + ($1.mirror?.state.waitingCount ?? 0) } }
}

/// 打破 hub ↔ 通讯录服务的初始化环。
private final class HubBox: @unchecked Sendable {
    @MainActor weak var hub: ConnectionHub?
}
