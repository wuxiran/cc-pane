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

- `-autoConnect YES`：启动即连接当前电脑（地址簿里选中的那台，多地址择优）
- `-openSession <sessionId>`：连接后直接进入该会话终端
- `-initialTab chat|workspace|terminal|settings`：初始 tab
- `-acpMock YES`：「对话」走进程内 mock（含 `user_prompt` / `permission_resolved` / configOptions / Bot 对话）；
  `-openChat <chatId>` 直接打开该对话，`-acpMockResolveAfter N` N 秒后模拟「电脑端已审批」
- `-pairAddress <url> -pairCode <6位>`：启动即配对并连接（配合本地假服务验证配对流程）
- `-connectMode pair|direct`：连接页默认方式（默认「配对码」）

```bash
xcrun simctl launch --terminate-running-process <udid> com.ccpanes.ios -autoConnect YES -openSession <id>
```

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
- [ ] P4 Bot 通讯录；P5 灵动岛 / 推送、在线状态续租；协议版本协商（426）
- [ ] 真机验收：中文输入法、硬件键盘、iPad 分栏、Wi-Fi/蜂窝切换
