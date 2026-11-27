import Foundation
import Observation

/// 「对话」tab：活会话 + 落盘历史 + 引擎清单。可见时每 4s 轮询活会话（状态 / 审批角标）。
@MainActor
@Observable
final class ChatListModel {
    private(set) var chats: [AcpChatSummary] = []
    private(set) var history: [AcpHistoryEntry] = []
    private(set) var engines: [AcpEngineInfo] = []
    private(set) var loaded = false
    private(set) var hostUnavailable = false
    private(set) var error: String?

    let service: any AcpService

    init(service: any AcpService) { self.service = service }

    /// 待审批总数（tab 角标）。
    var pendingTotal: Int { chats.reduce(0) { $0 + ($1.pendingPermissions ?? 0) } }

    /// 历史中去掉正在跑的（同 acpSessionId）。
    var visibleHistory: [AcpHistoryEntry] {
        let live = Set(chats.compactMap(\.acpSessionId))
        return history.filter { !live.contains($0.acpSessionId) }
    }

    func reload() async {
        let service = self.service
        async let list = service.chats()
        async let past = service.history()
        async let engineList = service.engines()
        do {
            chats = try await list
            hostUnavailable = false
            error = nil
        } catch AcpError.hostUnavailable {
            hostUnavailable = true
            chats = []
        } catch {
            if chats.isEmpty { self.error = error.localizedDescription }
        }
        history = (try? await past) ?? history
        engines = (try? await engineList) ?? engines
        loaded = true
    }

    func poll() async {
        while !Task.isCancelled {
            await reload()
            try? await Task.sleep(for: .seconds(4))
        }
    }

    func create(engineId: String, cwd: String, resume: String? = nil) async throws -> ChatRoute {
        let snapshot = try await service.create(engineId: engineId, cwd: cwd, resumeAcpSessionId: resume)
        guard let chatId = snapshot.chatId else { throw AcpError.other("服务端未返回 chatId") }
        await reload()
        return ChatRoute(chatId: chatId, title: snapshot.title ?? pathBasename(cwd), engineId: engineId)
    }

    func route(for chat: AcpChatSummary) -> ChatRoute {
        ChatRoute(chatId: chat.chatId, title: chat.displayTitle, engineId: chat.engineId)
    }
}
