# CC-Panes OpenHarmony 版移植方案

> 目标：把 cc-pane 的移动客户端体验（参照 `cc-panes-mobile` Flutter 版，安卓/iPhone 同款设计）带到 OpenHarmony。
> 形态：**纯客户端 ArkTS 应用**，通过局域网/Tailscale 连接桌面端 `cc-panes-web` 服务器，查看和操作运行中的 Claude Code 终端会话。
> 后端零改动——REST + WS 契约完全复用。

---

## 1. 定位与范围

### 1.1 为什么是"客户端/服务器"而不是完整移植

- Claude Code CLI 依赖 Node.js，无法在 OpenHarmony 上本地运行 PTY 会话；
- 桌面端仓库已有 `cc-panes-web`（axum，为 Docker 部署设计，零 Tauri 依赖），暴露完整 REST + WS 契约；
- Flutter 移动版已验证这条路径（安卓/iPhone 同款），OpenHarmony 版对齐它的设计与交互即可。

### 1.2 范围（对齐 Flutter 版当前能力）

| 功能 | 说明 |
|---|---|
| 服务器连接 | 地址 + 账号密码，Cookie 会话静默重登 |
| 双 Tab 首页 | Tab0 工作区浏览（指标条/工作区卡/项目行 + 电脑在跑/手机打开徽标）；Tab1 终端镜像（按桌面布局快照分组的会话卡） |
| 终端屏幕 | xterm 渲染 + WS 实时输出 + 快捷键条（KeyBar）+ 适配尺寸（opt-in resize） |
| 启动会话 | 项目 → 底部弹层选 Claude / Codex / 纯终端，或恢复最近 5 条历史会话 |
| 会话管理 | 5s 轮询状态、关闭会话（确认框）、最近输出预览（懒加载一次） |
| 只读模式 | 拦截输入与关闭操作，专属文案提示 |

### 1.3 不做（与 Flutter 版一致）

- 不做分屏拖拽（手机形态，一格一屏）；
- 不做多服务器管理 UI、WS 自动重连（Flutter 版 Phase 3 预留项，同步后置）；
- 不做桌面端专属功能（Git 面板、文件树、Monaco 编辑器、截图、MCP 配置）。

---

## 2. 总体架构

```
┌────────────────────────────────────────────────┐
│  OpenHarmony 应用 (ArkTS / ArkUI, API 12+)      │
│                                                │
│  pages/          Connect / MirrorHome /        │
│                  Terminal（Navigation 路由）    │
│  components/     WorkspaceCard / SessionTile / │
│                  MirrorCard / KeyBar / Sheets  │
│  stores/         auth / mirror / workspaces /  │
│                  launchHistory / terminal      │
│  services/       ApiClient(HTTP+Cookie) /      │
│                  TerminalSocket(WS) / 各 API   │
│  model/          数据模型 + fromJson            │
│                                                │
│  终端渲染：ArkUI Web 组件（rawfile 终端页）     │
│  ┌──────────────────────────────────────┐      │
│  │ WebView: xterm.js 6 + MapleMono 字体 │      │
│  │ ArkTS ⇄ JS 桥（input/output/resize） │      │
│  └──────────────────────────────────────┘      │
├────────────────────────────────────────────────┤
│  HTTP @ohos.net.http   WS @ohos.net.websocket  │
├────────────────────────────────────────────────┤
│  cc-panes-web（桌面端/Docker，复用不改）        │
│  REST /api/*   +   WS /ws/{sessionId}          │
└────────────────────────────────────────────────┘
```

### 2.1 技术选型

| 关注点 | 选型 | 理由 |
|---|---|---|
| UI 框架 | ArkUI 声明式（ArkTS） | OpenHarmony 原生 |
| 状态管理 | 状态管理 V2（@ObservedV2/@Trace + @ComponentV2） | 树形/列表观察细粒度，API 12 起可用，等价 Riverpod 的 Notifier 模式用单例 Controller 类实现 |
| HTTP | @ohos.net.http | 手动管理 Cookie（无自动 CookieJar） |
| WebSocket | @ohos.net.websocket | 握手可带 header（Cookie 复用） |
| 终端渲染 | ArkUI **Web 组件** + xterm.js 6（rawfile 本地页） | ArkTS 无 xterm 等价物；自研 VT 解析 + 网格渲染工作量不可控；Web 组件内 DOM 生态完整，字体/滚动/选区成熟 |
| 凭证存储 | @ohos.security.asset（Asset Store），降级 @ohos.data.preferences | 等价 flutter_secure_storage |
| 布局快照解析 | 纯函数移植（normalizeProjectPath / collectSessionCards / buildMirrorState） | Flutter 版有现成单测，直接翻译为验收标准 |
| 路由 | Navigation + NavPathStack | 命令式 push 对齐 Flutter 的 Navigator.push |

### 2.2 关键决策：终端用 Web 组件而非自绘

xterm.js 在 WebView 里承担 VT 解析、CJK 双宽、scrollback(5000)、触摸滚动；ArkTS 只做会话生命周期与桥接。代价是桥接层，收益是砍掉整个移植里最大不可控工作量（VT100/ANSI 解析器 + 等宽网格渲染）。

资源离线内置（不依赖运行时网络）：
- `xterm.js 6.0.0` + `addon-fit 0.11.0`（npm 已验证可下载，tarball 已取回）
- `MapleMonoNFCN-Regular.ttf`（20.6MB，从 cc-panes-mobile/assets/fonts 复制，@font-face 内嵌，OFL-1.1 许可证随包）

---

## 3. 目录结构（Flutter → ArkTS 映射）

```
entry/src/main/
├── ets/
│   ├── entryability/EntryAbility.ets        # 启动入口（暗色模式跟随系统）
│   ├── common/
│   │   ├── Config.ets                       # AppConfig 常量（轮询 5s、超时 10s、stale 阈值…）
│   │   ├── Result.ets                       # Result<T, ApiFailure>（network/unauthorized/readOnly/remoteForbidden/http/local）
│   │   ├── Format.ets                       # pathBasename / 相对时间（刚刚/N 秒前/…）/ statusText+状态色映射
│   │   └── Theme.ets                        # teal 主色、明暗双色板、终端底色 #1E1E1E
│   ├── model/
│   │   ├── ServerProfile.ets / AuthStatus.ets / SessionInfo.ets
│   │   ├── Workspace.ets / LaunchRecord.ets / SavedSession.ets
│   │   ├── LayoutSnapshot.ets               # PaneNode/Tab/TerminalNode 树 + collectSessionCards + normalizeProjectPath
│   │   └── MirrorState.ets                  # buildMirrorState 纯函数产物
│   ├── services/
│   │   ├── ApiClient.ets                    # baseUrl、10s 超时、Cookie（ccp_web_session）提取/回带/持久化、guard() 错误映射
│   │   ├── AuthApi.ets / SessionsApi.ets / WorkspacesApi.ets
│   │   ├── HistoryApi.ets / LayoutSnapshotApi.ets
│   │   └── TerminalSocket.ets               # /ws/{id} 文本 JSON 帧，Cookie 握手，output/exit 下行、input/resize 上行
│   ├── stores/
│   │   ├── ServerStore.ets                  # profile 持久化（Asset Store），current 选择
│   │   ├── AuthController.ets               # 四态状态机（NoProfile/Connecting/Ready/Failed）+ 静默重登 + reconnect()
│   │   ├── MirrorController.ets             # 5s 轮询 layout-snapshot + sessions → buildMirrorState；launch/kill + _localMeta
│   │   ├── WorkspacesController.ets         # 一次性加载，pinned 优先 + displayName 排序；restoreLatestSnapshot
│   │   ├── LaunchHistoryStore.ets           # limit=100，失败空列表
│   │   └── TerminalController.ets           # phase 状态机、Web 桥管理、RefitPolicy（300ms 去抖、opt-in）、KeyBar 直通道
│   ├── components/
│   │   ├── WorkspaceCard.ets / ProjectRow.ets / MetricsRow.ets
│   │   ├── SessionTile.ets / MirrorCard.ets / GroupHeader.ets
│   │   ├── KeyBar.ets                       # Ctrl(粘滞)/Esc/Tab/^C/↑↓←→/Enter(\r)//、~
│   │   ├── LaunchSheet.ets                  # Claude/Codex/终端 三按钮 + 最近 5 条恢复
│   │   ├── WorkspaceActionsSheet.ets
│   │   └── TerminalWebView.ets              # Web 组件封装：加载 rawfile 终端页 + 双向桥
│   └── pages/
│       ├── Index.ets                        # 根路由：按 AuthState 切 Connect / 首页 / loading
│       ├── ConnectPage.ets
│       ├── MirrorHomePage.ets               # 底部双 Tab（Tabs + TabContent 保持状态）
│       ├── WorkspaceTab.ets
│       └── TerminalPage.ets                 # 顶栏(标题+适配尺寸) + 终端 + 状态横幅 + KeyBar
└── resources/rawfile/terminal/
    ├── index.html                           # xterm 宿主页（@font-face + 桥脚本）
    ├── xterm.js / xterm.css / fit.js        # npm dist 离线拷贝
    └── MapleMonoNFCN-Regular.ttf
```

权限（module.json5）：`ohos.permission.INTERNET`（HTTP/WS/Web 组件联网）。

---

## 4. 核心数据流

### 4.1 启动与登录（对齐 Flutter _Root）

```
EntryAbility → Index.ets
  读 ServerStore.current:
    无 → ConnectPage
    有 → AuthController.connect():
      GET /api/auth/status
        ├─ 网络失败 → ConnectPage(错误文案：无法连接服务器…)
        ├─ 免登录/已认证 → MirrorHomePage
        └─ 需登录 → POST /api/auth/login（存好的账号密码）
             ├─ 失败/未通过 → ConnectPage（用户名或密码错误）
             └─ 成功 → 再 GET status → MirrorHomePage
  任意页面遇 401 → AuthController.reconnect() 重跑上面流程
```

### 4.2 首页双 Tab

- **Tab0 工作区**：`GET /api/workspaces` → 指标条（工作区/项目/置顶/隐藏）→ 工作区卡（名称/path/pills/⋯ 菜单）→ 项目行（名称/path + 「电脑在跑」「手机打开」徽标）→ 点按弹 LaunchSheet。
- **Tab1 终端镜像**：`GET /api/layout-snapshot/default` + `GET /api/sessions`（并行，5s 轮询）→ `buildMirrorState()` 合成分组（布局组[当前布局最前] / 手机远程会话组 / 未归入布局组[过滤已退出与 >5min 陈旧]）→ 会话卡（状态点/cliTool 徽标/Pane N/最近输出单行预览[lines=2 懒加载一次]）。
- 顶栏：工作区 Tab 固定「CC-Panes」；镜像 Tab 显示快照 workspaceName + 「同步于 X 前」+ 陈旧 Chip(>90s) + 只读 Chip + 手动刷新。

### 4.3 终端屏幕（桥接协议）

```
TerminalPage(sessionId, title)
  1. GET /api/sessions/{id}/snapshot → VT 回放数据（拿不到不阻塞）
  2. TerminalWebView 加载 rawfile/terminal/index.html
     JS 侧 onReady → 桥注入 snapshot（xterm.write）
  3. TerminalSocket 连 ws(s)://host/ws/{sessionId}（Cookie 握手）
     output → base64 → runJavaScript: ccpTerm.write(b64)   （8ms 合批，防高频碎调用）
     exit   → phase=exited 横幅「会话已退出（exit N）」
     断开    → phase=error 横幅 +「重连」按钮（销毁重建 controller）
  4. JS 侧键盘输入 → javaScriptProxy: ccpBridge.onInput(data) → 只读丢弃 / Ctrl 粘滞转换 → WS input
  5. KeyBar → sendSequence 直通道（\x1b/\t/\x03/\x1b[A…/\r//、~）
  6. 适配尺寸（opt-in）：ccpBridge.onGeometry(cols,rows) → WS resize
     顶栏按钮首次点击 markUserFitted()，之后尺寸变化经 300ms 去抖自动重发
```

**桥传输格式**：VT 流含任意控制字节，JSON 转义易碎——统一 **base64** 过桥（ArkTS `util.Base64Helper` 编码，JS `atob` + TextDecoder 流式 UTF-8 解码），规避转义与 CJK 断裂问题。

### 4.4 后端契约速查（全部复用，零改动）

| 用途 | 端点 |
|---|---|
| 登录态 | GET `/api/auth/status`、POST `/api/auth/login` |
| 会话 | GET/POST `/api/sessions`、DELETE `/api/sessions/{id}`、GET `?output?lines=2`、GET `/snapshot`、POST `/resize` |
| 工作区 | GET `/api/workspaces`、GET `/api/workspace-snapshots/{name}`、POST `…/{wid}/{sid}/restore` |
| 历史 | GET `/api/launch-history?limit=100`、GET `/api/terminal-sessions` |
| 布局 | GET `/api/layout-snapshot/default` |
| 终端流 | WS `/ws/{sessionId}`：下行 `{type:output|exit,…}`、上行 `{type:input|resize,…}` |

关键常量：轮询 5s / HTTP 超时 10s / WS 握手 10s / 快照陈旧 90s / 孤儿隐藏 5min / 建会话默认 120×30 / scrollback 5000 / Enter 发送 `\r` 非 `\n`。

---

## 5. 分期计划

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P1 骨架+连接** | 目录结构、Result/错误映射、ApiClient(Cookie)、models、ConnectPage、静默登录、权限 | hvigor 编译通过；真机可登录进空首页 |
| **P2 终端** | rawfile 终端页（xterm+字体+桥）、TerminalSocket、TerminalPage、KeyBar、适配尺寸 | 连真实桌面端，能看到 Claude 输出流、可输入、快捷键可用 |
| **P3 首页** | 双 Tab、工作区卡、镜像分组（buildMirrorState 移植 + 单测）、LaunchSheet、关闭会话、输出预览、只读拦截 | 手机看到桌面布局镜像分组；能从项目启动 Claude 会话 |
| **P4 打磨** | 明暗主题、快照恢复入口、错误重试、断线横幅、（预留）WS 自动重连退避 | 对齐 Flutter 版全部行为清单 |

估算：P1 约 15 个文件、P2 约 6 个、P3 约 10 个、P4 修补；总量对标 Flutter 版 3930 行的 1.2~1.5 倍（ArkTS 声明式 UI 略啰嗦 + 桥接层）。

---

## 6. 已完成的准备工作（本次调研验证）

1. **工具链**：`cc_panes` 脚手架（API 14 / OpenHarmony / entry 模块）已就位；本机 DevEco 5 的 hvigor 仅支持 modelVersion 5.0.5，已把 `hvigor/hvigor-config.json5` 与 `oh-package.json5` 从 6.0.1 降到 5.0.5，`hvigorw --sync` 通过（后续用更高版本 DevEco 打开可无损升回）。
2. **命令行构建**：`"C:/Program Files/Huawei/DevEco Studio/tools/hvigor/bin/hvigorw.bat" assembleHap` 可用于无 IDE 编译验证；SDK 在 `D:/openharmonySDK/SDK`（API 10/11/12/14）。
3. **终端资源**：npm 源可达，`@xterm/xterm@6.0.0` + `@xterm/addon-fit@0.11.0` tarball 已下载到 `/tmp/xterm-pack`；`MapleMonoNFCN-Regular.ttf` + OFL 许可证在 `cc-panes-mobile/assets/fonts/` 可直接复制。
4. **设计蓝本**：Flutter 版 37 个 Dart 文件已逐行调研成移植规格（页面结构/字段表/端点表/状态机/常量表），本方案第 3、4 节为其 ArkTS 化映射。
5. **桌面端契约**：cc-panes-web 的 REST/WS/鉴权源码已核对，与移动版用法一致。

---

## 7. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| ArkUI Web 组件在目标 OpenHarmony 设备的可用性 | 终端无法渲染 | 纯 OpenHarmony 系统镜像一般含 ArkWeb；真机验证放 P2 首项；不可用则退化为自绘方案（工作量 ×3，需重新评估） |
| runJavaScript 高频调用性能 | 输出卡顿 | 8ms 合批 + 增量 base64；必要时切换二进制通道（postCardMessage 不可用则继续 JSON） |
| 20MB 字体打包体积 | 安装包大 | 可接受（Flutter 版同款）；必要时子采样常用字符集 |
| Cookie 跨 HTTP/WS 一致性 | WS 被拒 | 手动提取 `set-cookie` 存内存+持久化，握手 header 显式携带；401 统一走静默重登 |
| 本机无 OH 模拟器 | UI 无法动态验证 | 开发期用 hvigor 编译 + DevEco 预览器 + 用户真机联调；纯函数（镜像合成）带单测 |
| 只读/远程来源判定差异 | 手机端被误判远程 | 沿用 Flutter 版行为：只读时拦截输入/关闭并提示「允许已登录的远程会话写入」开关文案 |

---

## 8. 开放问题（需确认）

1. 目标设备形态：手机（竖屏优先）还是平板也需适配？（方案默认手机，平板靠自适应布局顺带支持）
2. 是否需要把 Flutter 版已知缺陷在 OH 版顺手修掉（如：镜像首页缺「恢复布局」入口、空状态提到的 FAB 不存在、双 controller 数据源分裂）？建议 OH 版直接做单一数据源 + 补上恢复入口。
3. 签名与分发：调试签名由 DevEco 自动生成即可，发布签名待定。
