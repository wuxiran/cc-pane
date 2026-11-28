import Foundation
import Observation

/// 本机会话的全局入口：供应商 + 对话两个 store。首页、新建对话、搜索、设置共用这一份。
///
/// 调试（仅 DEBUG）：
/// - `-localMock YES`：数据落到独立目录 `CCPanesLocal-mock`、密钥用内存存储，LLM 请求走进程内
///   SSE 桩（`MockLLMProtocol`），并预置「Mock Claude」（Anthropic）/「Mock OpenAI」两个供应商；
///   消息里带 `#401` / `#overloaded` / `#slow` 可演示错误映射与停止。
/// - `-openLocalChat <chatId|new>`：启动后在「对话」里直接打开该本机对话（`new` = 用第一个供应商新建）；
///   `-localAutoSend <text>`：打开后自动发一条。
/// - `-initialTab localModels`：打开电脑面板的「本机模型」页；`-localImportCode <6位>` 进入导入页并自动提交
///   （导入目标 = 第一台在线且已配对的电脑）。
@MainActor
@Observable
final class LocalEnvironment {
    static let shared = LocalEnvironment()
    /// `-openLocalChat` 只消费一次。
    static var debugRouteConsumed = false

    let providers: LocalProviderStore
    let chats: LocalChatStore
    let isMock: Bool

    init(root: URL? = nil, secrets: (any SecretStore)? = nil, client: LLMClient? = nil,
         defaults: UserDefaults = .standard) {
        #if DEBUG
        let mock = defaults.bool(forKey: "localMock")
        #else
        let mock = false
        #endif
        isMock = mock
        let directory = root ?? LocalStorage.defaultRoot(mock ? "CCPanesLocal-mock" : "CCPanesLocal")
        let store = LocalProviderStore(
            directory: directory,
            secrets: secrets ?? (mock ? MemorySecretStore() : KeychainSecretStore(service: LocalProviderStore.keychainService)))
        providers = store
        #if DEBUG
        let llm = client ?? (mock ? MockLLMProtocol.client() : LLMClient())
        #else
        let llm = client ?? LLMClient()
        #endif
        chats = LocalChatStore(directory: directory.appending(path: "chats", directoryHint: .isDirectory),
                               providers: store, client: llm)
        #if DEBUG
        if mock { MockLLMProtocol.seed(store) }
        #endif
    }

    /// 新建本机对话的默认（供应商, 模型）：上次用的 → 第一个有密钥且有模型的。
    func defaultSelection(last: String? = nil) -> (provider: LocalProvider, model: String)? {
        let usable = providers.providers.filter { providers.hasKey($0.id) }
        if let last, let provider = usable.first(where: { $0.id == last }), let model = provider.preferredModelId {
            return (provider, model)
        }
        for provider in usable { if let model = provider.preferredModelId { return (provider, model) } }
        return nil
    }

    /// 本机对话的导航路由（与远程对话同一个 `ChatRoute`，computerId 为伪电脑 id）。
    static func route(_ chat: LocalChat) -> ChatRoute {
        ChatRoute(chatId: chat.id, title: chat.title, engineId: "local", computerId: LocalChatListItem.computerId)
    }

    static func isLocal(_ route: ChatRoute) -> Bool { route.computerId == LocalChatListItem.computerId }
}
