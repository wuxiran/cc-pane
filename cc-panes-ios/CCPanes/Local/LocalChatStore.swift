import Foundation
import Observation

/// 本机对话：每条一个 JSON（`CCPanesLocal/chats/<id>.json`），在手机上直连 LLM 流式生成。
/// 列表行（`listItems`）按合并「对话」列表的形状给出，所属电脑是伪电脑「本机 iPhone」。
@MainActor
@Observable
final class LocalChatStore {
    private(set) var chats: [LocalChat] = []
    /// 正在生成的对话 id。
    private(set) var generating: Set<String> = []

    @ObservationIgnored let providers: LocalProviderStore
    @ObservationIgnored let client: LLMClient
    @ObservationIgnored let directory: URL
    @ObservationIgnored private var tasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var lastPersist: [String: Date] = [:]

    init(directory: URL = LocalStorage.defaultRoot().appending(path: "chats", directoryHint: .isDirectory),
         providers: LocalProviderStore, client: LLMClient = LLMClient()) {
        self.directory = directory
        self.providers = providers
        self.client = client
        reload()
    }

    func reload() {
        LocalStorage.ensureDirectory(directory)
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        chats = files.filter { $0.pathExtension == "json" }
            .compactMap { LocalStorage.read(LocalChat.self, from: $0) }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    func chat(_ id: String) -> LocalChat? { chats.first { $0.id == id } }

    func isGenerating(_ id: String) -> Bool { generating.contains(id) }

    var listItems: [LocalChatListItem] {
        chats.map { chat in
            LocalChatListItem(
                id: chat.id, title: chat.title, preview: chat.preview, updatedAt: chat.updatedAt,
                providerName: providers.provider(chat.providerId)?.name ?? "未知供应商",
                modelId: chat.modelId, isGenerating: generating.contains(chat.id),
                hasError: chat.messages.last?.error != nil)
        }
    }

    // MARK: - CRUD

    @discardableResult
    func create(providerId: String, modelId: String, systemPrompt: String? = nil) -> LocalChat {
        let chat = LocalChat(providerId: providerId, modelId: modelId, systemPrompt: systemPrompt)
        upsert(chat, persist: true)
        return chat
    }

    func rename(_ id: String, to title: String) {
        guard var chat = chat(id) else { return }
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        chat.title = trimmed.isEmpty ? LocalChat.untitled : trimmed
        chat.titleIsCustom = !trimmed.isEmpty
        upsert(chat, persist: true)
    }

    func setModel(_ id: String, providerId: String, modelId: String) {
        guard var chat = chat(id) else { return }
        chat.providerId = providerId
        chat.modelId = modelId
        upsert(chat, persist: true)
    }

    func delete(_ id: String) {
        cancel(id)
        chats.removeAll { $0.id == id }
        try? FileManager.default.removeItem(at: fileURL(id))
    }

    // MARK: - Generation

    /// 发一条消息并流式生成回复。返回 false = 正在生成 / 空消息 / 对话不存在。
    @discardableResult
    func send(_ id: String, text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !generating.contains(id), var chat = chat(id) else { return false }
        if !chat.titleIsCustom && !chat.messages.contains(where: { $0.role == .user }) {
            chat.title = LocalChat.autoTitle(from: trimmed)
        }
        chat.messages.append(LocalMessage(role: .user, text: trimmed))
        upsert(chat, persist: true)
        start(id)
        return true
    }

    /// 重试最后一轮：丢掉末尾失败 / 停止的助手消息，重新生成。
    func retry(_ id: String) {
        guard !generating.contains(id), var chat = chat(id) else { return }
        if chat.messages.last?.role == .assistant { chat.messages.removeLast() }
        guard chat.messages.last?.role == .user else { return }
        upsert(chat, persist: true)
        start(id)
    }

    func cancel(_ id: String) {
        tasks[id]?.cancel()
    }

    private func start(_ id: String) {
        guard var chat = chat(id) else { return }
        let assistant = LocalMessage(role: .assistant, text: "", model: chat.modelId)
        let assistantId = assistant.id
        chat.messages.append(assistant)
        upsert(chat, persist: false)
        generating.insert(id)

        let request: LLMRequest
        do {
            request = try makeRequest(for: chat)
        } catch {
            finish(id, assistantId: assistantId, error: LLMError.from(error))
            return
        }
        let stream = client.stream(request)
        tasks[id] = Task { [weak self] in
            var failure: LLMError?
            do {
                for try await delta in stream {
                    self?.apply(delta, chatId: id, assistantId: assistantId)
                }
            } catch {
                failure = LLMError.from(error)
            }
            if Task.isCancelled { failure = .cancelled }
            self?.finish(id, assistantId: assistantId, error: failure)
        }
    }

    private func makeRequest(for chat: LocalChat) throws -> LLMRequest {
        guard let provider = providers.provider(chat.providerId) else {
            throw LLMError.decoding("对话使用的供应商已删除，请换一个模型")
        }
        guard let key = providers.apiKey(for: provider.id) else { throw LLMError.missingKey }
        // 历史：跳过失败 / 空的助手消息（否则会出现连续两条 user，Anthropic 会合并、多数中转会报错）。
        let turns = chat.messages.dropLast().compactMap { message -> LLMRequest.Turn? in
            if message.role == .assistant && (message.text.isEmpty || message.error != nil) { return nil }
            return LLMRequest.Turn(role: message.role, text: message.text)
        }
        return LLMRequest(kind: provider.kind, baseURL: provider.baseURL, apiKey: key,
                          model: chat.modelId, system: chat.systemPrompt, turns: Self.normalize(turns))
    }

    /// 合并相邻同角色轮次（用户连发两条、中间那条失败时）。
    static func normalize(_ turns: [LLMRequest.Turn]) -> [LLMRequest.Turn] {
        var result: [LLMRequest.Turn] = []
        for turn in turns {
            if let last = result.last, last.role == turn.role {
                result[result.count - 1].text += "\n\n" + turn.text
            } else {
                result.append(turn)
            }
        }
        return result
    }

    private func apply(_ delta: LLMDelta, chatId: String, assistantId: String) {
        mutateMessage(chatId, assistantId) { message in
            switch delta {
            case .text(let text): message.text += text
            case .thinking(let text): message.thinking = (message.thinking ?? "") + text
            case .usage(let input, let output):
                var usage = message.usage ?? LLMUsage()
                usage.merge(input: input, output: output)
                message.usage = usage
            case .stop(let reason): message.stopReason = reason
            case .model(let model): message.model = model
            }
        }
        // 流式中节流落盘（被杀进程也不至于整段丢）。
        if Date.now.timeIntervalSince(lastPersist[chatId] ?? .distantPast) > 1.5, let chat = chat(chatId) {
            persist(chat)
        }
    }

    private func finish(_ chatId: String, assistantId: String, error: LLMError?) {
        tasks[chatId] = nil
        generating.remove(chatId)
        mutateMessage(chatId, assistantId) { message in
            switch error {
            case .cancelled?: message.cancelled = true
            case let error?: message.error = error.errorDescription
            case nil:
                if message.text.isEmpty && (message.thinking ?? "").isEmpty { message.error = LLMError.emptyResponse.errorDescription }
                if message.stopReason == "refusal" { message.error = "模型拒绝回答该请求（refusal）" }
            }
        }
        if let chat = chat(chatId) { persist(chat) }
    }

    private func mutateMessage(_ chatId: String, _ messageId: String, _ body: (inout LocalMessage) -> Void) {
        guard let chatIndex = chats.firstIndex(where: { $0.id == chatId }),
              let messageIndex = chats[chatIndex].messages.firstIndex(where: { $0.id == messageId }) else { return }
        body(&chats[chatIndex].messages[messageIndex])
        chats[chatIndex].updatedAt = .now
    }

    // MARK: - Persistence

    private func upsert(_ chat: LocalChat, persist shouldPersist: Bool) {
        var chat = chat
        chat.updatedAt = .now
        if let index = chats.firstIndex(where: { $0.id == chat.id }) { chats[index] = chat } else { chats.insert(chat, at: 0) }
        chats.sort { $0.updatedAt > $1.updatedAt }
        if shouldPersist { persist(chat) }
    }

    private func persist(_ chat: LocalChat) {
        lastPersist[chat.id] = .now
        try? LocalStorage.write(chat, to: fileURL(chat.id))
    }

    func fileURL(_ id: String) -> URL {
        // id 只用自己生成的 UUID；防御性过滤路径字符。
        let safe = id.filter { $0.isLetter || $0.isNumber || $0 == "-" }
        return directory.appending(path: "\(safe).json")
    }
}
