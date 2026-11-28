# CC-Panes iOS（原生 SwiftUI）

iPhone / iPad 原生客户端：远程查看、操作电脑上 CC-Panes 的终端会话。设计参照 t3code 的移动端
（连接、序号续传、后台策略），但用 SwiftUI 原生实现。Flutter 版 `cc-panes-mobile/` 保留给 Android。

## 构建

```bash
brew install xcodegen          # 或下载 XcodeGen release 二进制
xcodegen generate              # 由 project.yml 生成 CCPanes.xcodeproj（不入库）
xcodebuild -project CCPanes.xcodeproj -scheme CCPanes \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -skipPackagePluginValidation -skipMacroValidation build
```

`-skipPackagePluginValidation` 是必需的：SwiftTerm 带 build-info 插件，命令行构建不加会卡在
"Validate plug-in"。在 Xcode 里打开时点一次「Trust & Enable」即可。

## 调试启动参数

- 地址簿里开着「保持连接」的电脑**同时在线**（ConnectionHub），无需选「当前电脑」；`-autoConnect YES` 保留兼容（已是默认行为）
- `-openSession <sessionId>`：连接后直接进入该会话终端（按会话所在电脑自动匹配）
- `-initialTab chat|contacts|terminal|workspace|search|settings|computers`：初始 tab；`settings` = 落在「对话」并打开电脑面板 → 设置，
  `computers` = 只打开电脑面板；`-searchQuery <文本>` 搜索 tab 预填查询
- `-simulateOffline YES`（DEBUG）：底部状态条把第一台电脑显示为离线（截图验证橙色态）；`-autoScroll YES`（DEBUG）：终端 tab 3 秒后滚到底
- `-acpMock YES`：「对话」走进程内 mock（含 `user_prompt` / `permission_resolved` / configOptions / Bot 对话）；
  `-openChat <chatId>` 直接打开该对话，`-acpMockResolveAfter N` N 秒后模拟「电脑端已审批」
- 真后端联调（仅 DEBUG，`AcpDebugHooks`）：`-acpCreate '<engineId>|<cwd>'` 启动即新建对话；`-acpAutoSend <text>` 首次 live 后发一条；
  `-acpAutoApprove <optionId|cancel> -acpAutoApproveAfter N` 审批卡出现 N 秒后自动回复；`-acpDropAfter N` live 后 N 秒模拟断线（验 afterSeq 续传）；
  每次合批把 transcript 摘要写到 `Documents/acp-debug-<chatId>.json`（`simctl get_app_container … data` 取证）
- `-pairAddress <url> -pairCode <6位>`：启动即配对并连接（配合本地假服务验证配对流程）
- `-connectMode pair|direct`：连接页默认方式（默认「配对码」）
- `-directAddress <url>[,<url>…]`：启动即把这些地址各记为一台电脑并同时连接（免登录服务端，截图 / UI 调试用）；
  `-directOnly YES` 同时暂停地址簿里其他电脑。mock（`-acpMock` / `-mockMirror`）只挂在第一个地址那台电脑上，免得多台各显示一份样例
- `-mockMirror YES`：「终端」tab 用内置样例布局（八个布局、四种相位），不请求镜像接口；另追加两台虚拟电脑
  （在线的「Windows 工作站」三个布局 + 离线的「build-nas」），测多电脑密度
- `-layoutPicker YES`：「终端」tab 启动即打开布局 / 电脑选择器；`-layoutPickerMode layouts|computers` 选视角（同时也是持久化键），
  `-layoutPickerDetent large` 直接展开、`-layoutPickerQuery <文本>` 预填搜索（截图用）
- `-mirrorLayout <布局名>`：「终端」tab 默认选中该布局（仅在未主动选择时生效）；`-launchSheet <项目名>`：「工作区」打开该项目的启动 sheet（只打开不启动）
- `-appearance system|light|dark`：外观（设置页「外观」同一开关，默认跟随系统）
- `-mockContacts YES`：「通讯录」用内置样例（本机 / Tailscale / 离线三台电脑，覆盖待审批、工作中、未启动与四级远程权限），
  对话落到进程内 ACP mock（建议同时带 `-acpMock YES`）；`-openContact <电脑id/botId>` 直接进 Bot 对话，
  `-contactDetail <电脑id/botId>` 直接进详情，`-contactConfirmFull YES` 进详情即弹「完全信任」确认（mock 电脑 id：`mock-mac` / `mock-win` / `mock-nas`；
  真后端用 `current/<botId>` 指代当前电脑）
- 通讯录联调（仅 DEBUG）：`-contactSetPolicy <deny|ask_origin|allowlist|full>` 进详情后走点按同一路径 PATCH（full 先弹红色确认 2 秒再带 `confirmFull:true`），
  `-contactSetKinds read,search` 改 allowlist 类型；`-acpAutoApprove kind:allow_once` 按选项 kind 自动审批（真引擎 optionId 不固定）

- 本机会话（docs/112 §6，`CCPanes/Local/`）：`-localMock YES` 本机对话走进程内 SSE 桩（独立数据目录 + 内存密钥 + 两个 mock 供应商，
  消息带 `#401` / `#overloaded` / `#slow` 演示错误与停止）；`-openLocalChat <chatId|new|latest>` 直接进本机对话，`-localAutoSend <text>` 进入后发一条；`-openNewChat YES` 打开新建对话（`-ccpanes.lastChatComputer local-iphone` 预选本机）；
  `-initialTab localModels` 打开「本机模型」页，`-localImportCode <6位>` 进导入页并自动提交（目标 = 第一台在线且已配对的电脑）

```bash
xcrun simctl launch --terminate-running-process <udid> com.ccpanes.ios -autoConnect YES -openSession <id>
# 两台同时在线（dev 18081 + release 18080 只读查看）
xcrun simctl launch --terminate-running-process <udid> com.ccpanes.ios \
  -directAddress http://127.0.0.1:18081,http://127.0.0.1:18080 -directOnly YES -acpMock YES -mockMirror YES -mockContacts YES
```

截图辅助（真实手势下滑，验证 iOS 26 tab 栏收起 + 状态条并排）：独立 scheme `CCPanesUIShots`（不进 `CCPanes` 的测试集），
`TEST_RUNNER_SHOT_DIR=<目录> TEST_RUNNER_SHOT_ADDRESS=<地址> xcodebuild test -scheme CCPanesUIShots …`。

## 首页（iOS 26 Liquid Glass）

- 四个主 tab：对话 · 通讯录 · 终端 · 工作区（线条 SF Symbol，选中由系统填充）+ 独立搜索 tab（`Tab(role: .search)`，右侧单独玻璃圆，搜索框落在底部）。
  角标为各电脑之和：对话 = 非 Bot 对话待审批，通讯录 = Bot 待审批，终端 = 等待输入。
- 统一搜索跨全部在线电脑：对话（含历史续接）/ Bot / 项目 / 终端会话分组，结果带电脑名，点按切 tab 并打开；输入电脑名可只看那台。
  原「对话 / 通讯录 / 工作区」顶部搜索框已并入（结果直接打开对话 / Bot / 启动 sheet，覆盖原过滤用途）。
- 底部状态条（`tabViewBottomAccessory`）：「N 台在线 · 线路」+ 待审批数，点按跳第一条待审批（无则打开电脑面板）；
  有电脑离线 / 令牌失效时转橙色并给原因，点按重连（令牌失效 → 电脑面板重新配对）。tab 栏下滑收起（`.tabBarMinimizeBehavior(.onScrollDown)`），
  收起时状态条缩成并排的紧凑胶囊；全屏终端时 tab 栏与状态条一起隐藏（状态条隐藏需 iOS 26.1 的 `isEnabled`）。
- 「终端」tab：标题即范围切换器（「布局名 ▾ 2/8」+「电脑 · N 会话 · 同步于…」），点按弹出选择器 sheet（medium / large）：
  「按布局」两列卡片网格（多电脑按电脑分节，首项「全部会话」）/「按电脑」电脑列表（点行 = 该电脑全部布局，展开可直接选布局），
  顶部搜索按布局名 / 电脑名过滤。内容区左右滑在当前范围的布局间翻页（分页容器，首页「全部」按布局分节）。
  范围 / 翻页逻辑在 `Core/MirrorScope.swift`（纯函数，`MirrorScopeTests`）；真实手势翻页见 `CCPanesUIShots` 的 `testLayoutPaging`。
- 各 tab 右上角统一的电脑按钮（状态点）→ 电脑面板：全部电脑的实时状态、线路、「保持连接」开关、改名 / 地址 / 重新配对 / 删除、配对新电脑、设置。
- 部署目标仍为 iOS 18：iOS 26 API 全在 `#available` 后；iOS 18 回落为常规 tab 栏 + 各 tab 底部的同款状态条（safeAreaInset）。
- 多电脑：`ConnectionHub` 为每台「保持连接」的电脑维持一条 REST 连接与各自的列表模型；按可见 tab 刷新（可见 5s，角标数据 30s，工作区可见时 30s），
  离线指数退避（2s 起，封顶 60s），回前台 / 下拉立即全量刷新；WebSocket 仍只在打开的对话 / 终端页上建立。
  显示名：用户改的名字 > 服务端 hostname > `host:port`；重名追加「开发版」或端口；同 `instanceId` 的多条地址自动合并。
  旧版电脑端（无 `/api/acp`、`/api/bots`）标「版本较旧」，终端 / 工作区照常。

## 配对与电脑地址簿（docs/112 §4）

- **配对码**：电脑端「设置 → Web 访问 → 其他设备 → 允许其他设备连接」生成 6 位码；手机连接页选「配对码」，
  填地址 + 码 → `POST /api/device/pair {code, name: 设备名}` 换 `ccp_dev_…` 令牌。
  令牌存 Keychain（`kSecClassGenericPassword`，service `com.ccpanes.ios.device-token`，account = 电脑 id，
  `AfterFirstUnlockThisDeviceOnly`），之后 REST 带 `Authorization: Bearer`，WS（终端 `/ws/{id}`、对话 `/ws/acp/{chatId}`）带 `?token=`。
  任一请求 401 → 回连接页提示「令牌失效，请重新配对」并预填地址。
- **直连**：原账号密码 / Cookie 登录保留，地址同样记入地址簿（未配对）。
- **地址簿**：设置 →「电脑」列表（在线点、当前勾选、左滑切换 / 删除、详情里改名 / 增删地址 / 重新配对）。
  非机密元数据存 UserDefaults（`ccpanes.computers.v1`），首次启动把旧版 `ccpanes.serverURL` 迁成一条。
  一台电脑可存多条地址：连接时并发探测 `/api/health`，局域网地址领跑 500ms，Tailscale（100.64/10、`*.ts.net`）
  等在领跑结束或局域网全部失败后才开探，先通者胜（`AddressProbe`）。名称取自 `/api/device/info` 的 hostname。

## 结构

```
CCPanes/
├── App/        入口、AppModel（电脑地址簿 + 当前连接 + 鉴权 / 配对）
├── Core/       APIClient（REST + 令牌注入）、Models、DirectRoute（本机/局域网绕过代理）、
│               ComputerBook（地址簿持久化 / 地址分类）、AddressProbe（多地址择优）、
│               DevicePairing（配对请求 / 响应映射）、SecretStore（Keychain / 内存 + TokenVault）
├── Chat/       ACP 对话：AcpClient / AcpSocket、AcpChatState（reducer）、AcpChatSession、Mock
├── Terminal/   TerminalSession（状态机）、OutputSequencer（快照/实时流按 endSeq 拼接）、
│               TerminalSocket（URLSessionWebSocketTask）、TerminalHost（SwiftTerm 封装）
├── Contacts/   通讯录（docs/112 §5）：ContactsService（协议 + live + mock，契约路径/字段只在这里与 BotContact.parse）、
│               ContactsModel（按电脑并发拉 /api/bots）、BotChatService（Bot 对话 = 那台电脑的 bot-{id} ACP chat）
└── Features/   连接页、会话列表、工作空间（新建会话）、设置
```

## 关键设计

- **不丢不重**：先连 `/ws/{id}` 并缓冲，再取 `/recovery-snapshot`（照片 + delta + `endSeq`），
  按帧 `endSeq` 裁掉被快照覆盖的部分后冲刷（`OutputSequencer`，含 UTF-8 边界处理）。
  旧服务端无 `/recovery-snapshot` 时回落 `/snapshot`。
- **共享 PTY 不擅改尺寸**：按 PTY 列数缩字号，使本端网格列数等于 PTY 列数；用户点
  「适配手机尺寸」才 resize 共享 PTY（会影响电脑端排版）。
- **世代号**：每次 attach 新世代，迟到的旧连接 / 快照直接丢弃；切后台断开、回前台重连。
- **本机 / 局域网直连**：模拟器继承 Mac 的 HTTP 代理时，REST 能通而 WS 升级被代理断开
  （POSIX 57 *Socket is not connected*），故私网/回环地址禁用代理（`DirectRoute`）。

## 路线图

- [x] P1 终端镜像：会话列表、工作空间新建会话、终端（快照 + WS 续传 + 快捷键条）、前后台恢复
- [x] P2 Agent Chat（iOS 侧）：ACP 事件环续传、`user_prompt` 按 promptId 去重、`*_resolved` 收卡、configOptions、Bot 徽标
- [x] P3 配对码换令牌（Keychain）+ 电脑地址簿（多台、多地址择优、在线状态）
- [ ] 桌面端配对二维码（`ccpanes://pair?host=…&code=…`）扫码填充
- [x] P4 Bot 通讯录（iOS 侧）：tab，按电脑分组（当前电脑在前）、在线态、搜索、Bot 对话（`/api/bots/{id}/messages` + `/ws/acp/bot-{id}`）、
  远程权限四档 + allowlist 类型（`PATCH /api/bots/{id}`，full 红色确认带 `confirmFull`）；未用 `/api/contacts` 转发（见 docs/112 §5.5）
- [x] P6 手机本地会话：直连 Anthropic / OpenAI 兼容 API（SSE），Keychain 存 key，从桌面导出码导入供应商（docs/112 §6）
- [ ] P5 灵动岛 / 推送、在线状态续租；协议版本协商（426）
- [ ] 真机验收：中文输入法、硬件键盘、iPad 分栏、Wi-Fi/蜂窝切换
