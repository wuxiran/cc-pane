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
    /// 电脑端版本没有 `/api/acp/*`（404）：对话能力不可用，但终端 / 工作区照常。
    private(set) var unsupported = false
    private(set) var error: String?

    let service: any AcpService

    init(service: any AcpService) { self.service = service }

    /// 待审批总数。
    var pendingTotal: Int { chats.reduce(0) { $0 + ($1.pendingPermissions ?? 0) } }
    /// 非 Bot 对话的待审批数（「对话」tab 角标；Bot 的算在「通讯录」）。
    var pendingNonBot: Int { chats.filter { !$0.isBot }.reduce(0) { $0 + ($1.pendingPermissions ?? 0) } }

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
        } catch AcpError.other("HTTP 404") {
            unsupported = true
            chats = []
            loaded = true
            return
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

    /// 所属电脑（ChatRoute 带上，聊天页据此找回这台电脑的服务）。
    var computerId = ""

    func create(engineId: String, cwd: String, resume: String? = nil) async throws -> ChatRoute {
        let snapshot = try await service.create(engineId: engineId, cwd: cwd, resumeAcpSessionId: resume)
        guard let chatId = snapshot.chatId else { throw AcpError.other("服务端未返回 chatId") }
        await reload()
        return ChatRoute(chatId: chatId, title: snapshot.title ?? pathBasename(cwd), engineId: engineId,
                         computerId: computerId)
    }

    func route(for chat: AcpChatSummary) -> ChatRoute {
        ChatRoute(chatId: chat.chatId, title: chat.displayTitle, engineId: chat.engineId, computerId: computerId)
    }
}
