import Foundation
import Observation

/// 「通讯录」tab 的状态：地址簿里每台电脑并发拉 Bot 目录，先到先显示；可见时每 10s 刷新。
@MainActor
@Observable
final class ContactsModel {
    private(set) var nodes: [ContactNode] = []
    private(set) var directories: [String: NodeDirectory] = [:]
    private(set) var loaded = false
    /// 已读标记变化时递增，驱动「新消息」点重算。
    private(set) var readTick = 0

    let service: any ContactsService
    @ObservationIgnored let marks: ContactReadMarks
    @ObservationIgnored private var refreshing = false

    init(service: any ContactsService, marks: ContactReadMarks = ContactReadMarks()) {
        self.service = service
        self.marks = marks
    }

    func sections(query: String) -> [ContactSection] {
        ContactsDirectory.sections(nodes: nodes, directories: directories, query: query)
    }

    /// 其他电脑上 Bot 的待审批数（tab 角标）。
    var remotePending: Int { ContactsDirectory.remotePending(nodes: nodes, directories: directories) }

    var totalBots: Int { directories.values.reduce(0) { $0 + $1.bots.count } }

    func node(_ id: String) -> ContactNode? { nodes.first { $0.id == id } }

    /// id = `电脑id/botId`；调试参数可用 `current/<botId>` 指代当前电脑（地址簿 id 是 UUID，不好手写）。
    func contact(_ id: String) -> BotContact? {
        var key = id
        if id.hasPrefix("current/"), let current = nodes.first(where: \.isCurrent) {
            key = current.id + id.dropFirst("current".count)
        }
        return directories.values.lazy.flatMap(\.bots).first { $0.id == key }
    }

    func isOnline(_ contact: BotContact) -> Bool { directories[contact.nodeId]?.status.isOnline ?? false }

    func isUnread(_ contact: BotContact) -> Bool {
        _ = readTick
        return marks.isUnread(contact)
    }

    func markSeen(_ contact: BotContact) {
        marks.markSeen(contact)
        readTick += 1
    }

    func reload(computers: [Computer], currentId: String?) async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        let next = service.nodes(computers: computers, currentId: currentId)
        nodes = next
        let ids = Set(next.map(\.id))
        directories = directories.filter { ids.contains($0.key) }
        await service.beginRefresh()
        let service = self.service
        await withTaskGroup(of: (String, NodeDirectory).self) { group in
            for node in next {
                if directories[node.id] == nil { directories[node.id] = NodeDirectory(status: .loading) }
                group.addTask { (node.id, await service.directory(of: node)) }
            }
            for await (id, directory) in group {
                directories[id] = directory
                marks.reconcile(directory.bots)
            }
        }
        loaded = true
    }

    func poll(computers: @escaping @MainActor () -> ([Computer], String?)) async {
        while !Task.isCancelled {
            let (list, current) = computers()
            await reload(computers: list, currentId: current)
            try? await Task.sleep(for: .seconds(10))
        }
    }

    func update(_ change: BotRemoteChange, for contact: BotContact) async throws {
        guard let node = node(contact.nodeId) else { return }
        // 以服务端回的 SharedBot 为准；回包解析不了时本地套用改动。
        let next = try await service.update(change, for: contact, node: node) ?? {
            var local = contact
            if let policy = change.policy { local.remotePolicy = policy }
            if let kinds = change.allowKinds { local.remoteAllowKinds = kinds }
            return local
        }()
        if var directory = directories[contact.nodeId],
           let i = directory.bots.firstIndex(where: { $0.id == contact.id }) {
            directory.bots[i] = next
            directories[contact.nodeId] = directory
        }
    }

    func chatService(for contact: BotContact) async -> (any AcpService)? {
        guard let node = node(contact.nodeId) else { return nil }
        return await service.chatService(for: contact, node: node)
    }
}
