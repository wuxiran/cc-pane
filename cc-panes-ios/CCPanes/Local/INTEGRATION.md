# 本机会话（P6）接线说明

> 设计与契约见 `docs/112-ios-client-and-bot-mesh.md` §6。下面的接线**已经完成**，本文件记录接入点，改外壳时对照。

## 组件

| 文件 | 作用 |
|------|------|
| `LocalModels.swift` | `LLMProtocol` / `LocalProvider`（无密钥）/ `LocalChat` / `LocalMessage` / `LocalChatListItem`（伪电脑 `local-iphone`「本机 iPhone」） |
| `LLMStreaming.swift` | `SSEParser`（按字节切行）、`AnthropicStreamDecoder`、`OpenAIStreamDecoder`、`LLMError`（中文） |
| `LLMClient.swift` | 请求构建（纯函数）+ `stream()` / `listModels()`；`session` 可注入 |
| `LocalProviderStore.swift` | `providers.json` + Keychain（service `com.ccpanes.ios.llm-key`）；`importPayload` |
| `LocalChatStore.swift` | `chats/<id>.json`；`send` / `cancel` / `retry` / `rename` / `delete` / `setModel`；`listItems` |
| `LocalEnvironment.swift` | 全局单例 `LocalEnvironment.shared`（两个 store）；`route(_:)` / `isLocal(_:)`；调试参数 |
| `ProviderExportClient.swift` | `POST /api/providers/export` 请求 / 响应映射；`ProviderImportTarget` |
| `MockLLMProtocol.swift` | DEBUG：进程内 SSE 桩（`-localMock YES` 与单测） |
| `UI/LocalChatScreen.swift` | 本机对话页 |
| `UI/LocalProvidersView.swift` | 「本机模型」列表 + `LocalProviderEditor`（手动添加 / 编辑 / 拉模型列表） |
| `UI/ProviderImportView.swift` | 输导出码导入 |
| `UI/LocalChatComponents.swift` | `LocalChip` / `LocalChatRow` / `LocalChatIcon` / `LocalNewChatSection` / `ConnectionHub.importTargets` |

## 接入点（已改的外壳文件）

1. **`Chat/UI/ChatTabView.swift`**：`navigationDestination(for: ChatRoute.self)` 先判 `LocalEnvironment.isLocal(route)` → `LocalChatScreen`；
   「进行中」分组用 `ActiveRow`（远程 `Entry` / 本机 `LocalChatListItem`）按时间混排；`canCreate` 恒为 true；空态文案；`-openLocalChat`。
2. **`Chat/UI/NewChatSheet.swift`**：「在哪里运行」选择器恒显示，末项「本机 iPhone」（tag = `LocalChatListItem.computerId`）；
   选中时显示 `LocalNewChatSection`，「开始」直接 `local.chats.create` 并回调 `LocalEnvironment.route(chat)`；「管理本机模型…」push `LocalProvidersView`。
3. **`Features/UnifiedSearch.swift`**：`Corpus.local`、`Hit.local`（tag = 「本机 iPhone」，去处 = 本机 `ChatRoute`）；
   **`Features/HomeChrome.swift`** 的 `SearchCorpus.build` 填 `LocalEnvironment.shared.chats.listItems`；**`SearchTabView.swift`** 行渲染。
4. **`Features/SettingsView.swift`**：电脑面板「本机 iPhone → 本机模型」（`ComputersRoute.localModels`）；设置页「本机模型（Provider）」。
   导入目标 = `hub.importTargets`（在线 + 有设备令牌）。
5. **`App/HomeRouter.swift`**：`ComputerSheetPage.localModels`（`-initialTab localModels`）；`-openLocalChat` 落在「对话」。
6. **`App/AppModel.swift` + `Features/ConnectView.swift`**：`localOnly`（连接页「先在本机使用」），地址簿为空也能进首页。
7. 底部状态条 / 角标**未改**：只统计真实电脑。

## 调试参数

`-localMock YES`（独立目录 + 内存密钥 + SSE 桩 + 两个 mock 供应商；同时打开 `localOnly`）、`-openLocalChat <id|new|latest>`、
`-localAutoSend <text>`、`-openNewChat YES`（打开新建对话；配 `-ccpanes.lastChatComputer local-iphone` 预选本机）、`-initialTab localModels`、`-localImportCode <6位>`（进导入页自动提交）。
