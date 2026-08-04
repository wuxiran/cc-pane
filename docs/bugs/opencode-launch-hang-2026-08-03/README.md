# CC-Panes OpenCode 启动卡死：代码对比、取证方案与一轮修复提示词

> 调研日期：2026-08-03
> 目标仓库：`F:\C26\demo\cc-pane`
> 参考仓库：`F:\C26\gitee.com\zhengjunkj\ccpanel`
> 文档类型：故障分析 + Windows 复现 runbook + 高级 AI 实施提示词

> 基线注意：本次只把参考仓库的 `HEAD` 和可追溯源码当作对比依据。检查时发现参考仓库工作区本身有大量未提交改动，因此没有把那些改动当成已验证实现，也没有对参考仓库做任何写操作。

## 1. 结论先行

当前“OpenCode 启动容易卡死”更像是**启动请求没有在可见时间内收敛**，不一定是 OpenCode 本身死锁。当前 UI 对普通新建终端直接等待 `terminalService.createSession()`；只有恢复队列路径有 45 秒超时，普通启动没有同等的前端 deadline。后台的 daemon 创建请求有 60 秒 socket 读超时，但本地 backend、WSL 冷启动、项目 hook 同步、配置文件写入、可执行文件解析和 PTY 创建仍可能在同一条同步链上停留很久。

最需要先修的不是 OpenCode TUI 的滚动、主题或会话反查，而是以下四件事：

1. 启动链必须有明确的阶段日志和总超时，超时后 UI 必须从“Starting terminal”进入可重试错误态。
2. 超时或失败必须清理已经创建的 PTY/子进程，不能留下后台孤儿进程，也不能让同一个 pane 永久占用一次启动身份。
3. Windows 下 `opencode.cmd`、自定义 launcher override、Node shim 和原生 `.exe` 必须统一解析并可验证，不能把不可执行的 shim 直接交给 ConPTY。
4. OpenCode 的临时 `OPENCODE_CONFIG` / `OPENCODE_TUI_CONFIG` 和项目插件写入必须是 best-effort、原子写入、可回滚，不能让配置 I/O 阻塞整个启动链或悄悄覆盖用户原生配置。

这份文档只记录从代码中已经确认的事实、优先级假设和可执行验证方法。Windows 桌面启动、WebView2、ConPTY、WSL 冷启动仍需要在 Windows 主机上完成最终确认。

## 2. 现象定义与影响

### 2.1 用户看到的现象

- 从工作空间、项目菜单或新建终端入口选择 OpenCode。
- pane 出现 `Starting terminal` / `startingTerminalHint`。
- 长时间没有 OpenCode TUI，也没有错误面板、重试按钮或退出提示。
- 有时后台能看到 `opencode`、`node`、`cmd`、`wsl.exe` 进程，但 UI 仍认为终端没有创建完成。
- 重复点击或切换布局后，可能出现多个启动尝试、孤儿进程、重复 pane 或下次恢复再次卡住。

### 2.2 影响范围

- 普通本地 OpenCode 新建终端。
- 带 provider、MCP、YOLO、系统 prompt 或项目插件同步的启动。
- Windows npm 全局安装产生的 `opencode.cmd` shim。
- WSL OpenCode 启动，尤其是发行版冷启动、WSL 路径转换和跨环境 MCP 注入。
- 恢复旧 OpenCode session 时的 resume 反查只会放大问题，但不是本次“启动卡住”的第一根因。

## 3. 两个仓库的链路对比

### 3.1 当前 `cc-pane` 的实际链路

```text
React TerminalView
  -> terminalService.createSession()
  -> Tauri create_terminal_session
  -> spawn_blocking(create_session_with_recovery)
  -> daemon backend 或本地 TerminalService
  -> profile/provider/MCP/WSL/hook/config 解析
  -> CliToolAdapter::build_command
  -> resolve executable / rewrite npm shim
  -> spawn_pty
  -> 建立 session、reader、writer、输出批处理线程
  -> 返回 session id
  -> 前端绑定 output/exit callback
```

关键代码位置：

- 前端等待与错误收敛：`web/components/panes/TerminalView.tsx:1458-1740`。
- 普通启动直接 `await terminalService.createSession()`：`web/components/panes/TerminalView.tsx:1560-1585`。
- 只有恢复队列封装了 45 秒超时：`web/components/panes/terminalRestoreQueue.ts:5-8,34-51,80-88`。
- Tauri 命令把创建放入 blocking 线程：`src-tauri/src/commands/terminal_commands.rs:118-173`。
- daemon 创建请求默认 60 秒：`cc-panes-core/src/services/daemon_client.rs:18-23,213-232`。
- daemon 服务端再把同步创建放入 `spawn_blocking`：`cc-panes-daemon/src/server.rs:754-766`。
- 当前核心启动函数从 profile/provider 解析开始：`cc-panes-core/src/services/terminal_service.rs:1328-1465`。
- 本地/WSL/SSH 分支最终都在 `cc-panes-core/src/services/terminal_service.rs:1597-1923` 汇合到 PTY。
- PTY 创建和 session 注册：`cc-panes-core/src/services/terminal_service.rs:1927-2095`。
- OpenCode 命令与配置注入：`cc-cli-adapters/src/opencode.rs:416-494,559-574`。

### 3.2 参考 `ccpanel` 的启动链路

参考仓库仍是更短的单体路径：

```text
NewTerminal / workspace
  -> TerminalManager::create_terminal
  -> OpenCodeAdapter::build_command
  -> cmd.exe /C 或 WSL shell
  -> portable-pty openpty + spawn
  -> 注册 Terminal
```

关键位置：

- 参考 OpenCode adapter：`src-tauri/src/cli_adapter/opencode.rs:13-84`。
- 参考临时配置与 TUI 配置：`src-tauri/src/cli_adapter/opencode.rs:86-212`。
- 参考统一终端创建：`src-tauri/src/terminal.rs:626-849`。

参考项目的 OpenCode adapter 主要做三件事：

1. 复制自定义 executable 或使用 `opencode`。
2. 过滤 Claude 专属参数，生成 `OPENCODE_CONFIG`。
3. 生成稳定的 `OPENCODE_TUI_CONFIG`，然后交给统一 PTY 启动。

当前 `cc-pane` 在此基础上增加了 provider 选择、launch profile、共享 MCP、项目 hook、orchestrator token、WSL/SSH、daemon 重连、恢复租约和输出回放。这些能力本身有价值，但每一项都增加了启动前阻塞点，因此必须把“能启动 OpenCode”与“附加能力初始化”拆成可观测、可降级的阶段。

## 4. 已从代码确认的事实

### 4.1 普通启动缺少前端超时

`TerminalView` 在没有现成 session 时调用 `terminalService.createSession()`，调用完成前不会执行 `onSessionCreated`，也不会进入错误面板。错误面板只有在 Promise reject 后才会显示。对应代码见 `web/components/panes/TerminalView.tsx:1502-1585,1686-1739`。

`TerminalTabContent` 的状态条件是“没有 `sessionId` 且没有 `launchError` 就显示启动中”，因此任何不 resolve、也不 reject 的后端调用都会永久显示启动中：`web/components/panes/TerminalTabContent.tsx:132-164,210-243`。

### 4.2 恢复路径有超时，但普通路径没有复用

`terminalRestoreQueue` 明确写着，WSL 冷启动、无响应 daemon、阻塞 hook sync 会让恢复队列永久占槽，所以增加了 45 秒 `withTimeout`。这说明项目已经承认启动链可能不收敛，但该保护只包住 `props.restoring` 路径，普通新建 OpenCode 没有相同保护。

### 4.3 daemon 60 秒不是全链路取消

`CREATE_SESSION_TIMEOUT = 60s` 只限制 daemon client 的 TCP 读等待。它不能自动中断已经进入 `spawn_blocking` 的 Rust 同步函数，也不保证已经启动的子进程会被清理。若客户端超时、daemon 之后才完成 spawn，就可能产生“UI 认为失败、后台实际多出一个 PTY”的分叉状态。

### 4.4 OpenCode 启动前有多项同步 I/O 和环境工作

当前本地分支在真正 `spawn_pty` 之前会做：

- launch profile 解析、provider 选择和环境变量合并。
- shared MCP 配置、profile 过滤和可能的 sidecar/mcp-proxy 配置。
- 项目 hook 同步：写入 `.opencode/plugins/ccpanes.js`。
- spec prompt / profile skill prompt 合并。
- OpenCode session 配置写入 `opencode.json` 和 `ccpanes-tui.json`。
- 用户全局 config/theme 读取、项目 theme 检测和必要时创建项目主题。
- 可执行文件解析、自定义 launcher override 处理和 Windows npm shim 重写。
- WSL/SSH 分支的路径解析、环境传播、MCP 可达性探测。

这些工作集中在 `cc-panes-core/src/services/terminal_service.rs:1328-1923` 和 `cc-cli-adapters/src/opencode.rs:58-494`。

### 4.5 Windows npm shim 是历史上真实修过的启动问题

当前仓库历史提交 `643a501` 和 `f1f2b09` 专门引入了 `resolve_executable`、常见 npm 安装目录扫描、`.cmd/.bat` shim 解析和 `node <entry>` / 原生 `.exe` 选择。说明“桌面进程 PATH 与交互式 shell 不一致”和“ConPTY 不能直接 CreateProcess `.cmd`”不是理论风险，而是这个项目以前已经遇到过的真实问题。

当前 `CliAdapterContext::resolve_launch` 对默认 executable 会调用 `rewrite_windows_npm_shim`，但对显式 launcher override 会直接返回解析后的 override：`cc-cli-adapters/src/lib.rs:521-575`。因此必须单独验证用户设置了 `C:\...\opencode.cmd`、裸命令 `opencode`、`opencode.exe`、Node JS entry 四种情况。

### 4.6 OpenCode adapter 已经比参考项目复杂很多

当前 adapter 的 `write_session_configs` 会同时生成：

- `OPENCODE_CONFIG`：MCP、system prompt、provider credentials、theme。
- `OPENCODE_TUI_CONFIG`：用户 TUI 配置合并、项目主题、`ccpanes-tui.json`。

同时还支持项目级 `ccpanes.js` 插件。配置写入失败会通过 `?` 向上返回，理论上可以报错；但如果某个外层 I/O 或 WSL 过程本身阻塞，前端没有 deadline，用户只会看到“卡死”。

### 4.7 返回 session id 发生在 PTY 创建之后

当前 `TerminalService::create_session` 只有在 `spawn_pty` 成功、保存 `TerminalSession`、启动批量输出线程之后才返回 session id：`cc-panes-core/src/services/terminal_service.rs:2005-2095`。这使得前端没有办法在“进程已存在但初始化尚未完成”时显示可取消、可杀死的 session。

## 5. 根因假设，按优先级排序

### H1：启动链阻塞，但 UI 没有普通启动 deadline（最高概率）

**依据：** 普通路径无 timeout；后台创建包含多项同步工作；恢复路径已经为同类阻塞专门加了 45 秒保护。

**可观察结果：** 日志停在 `cmd::create_terminal_session`、某个 `create_session:*` 前置阶段或 `spawning PTY` 之前；UI 一直保持 `Starting terminal`；Promise 没有 reject。

**需要验证：** 给启动链加阶段日志后，记录最后一个 stage 和耗时；分别测试 `skipMcp=true`、不绑定 provider、禁用项目 hook、Local 与 WSL。

### H2：Windows executable / npm shim / launcher override 不可执行（高概率）

**依据：** 项目历史上已有 `os error 193`、npm shim 和 GUI PATH 修复；当前显式 override 与默认 executable 的处理路径不同。

**可观察结果：** `where.exe opencode` 能找到 `.cmd`，但 PTY 子进程没有真正进入 OpenCode；日志可能只有 spawn failure 或无输出。若 fallback 走 `cmd.exe /c`，还要排查参数、cwd 和隐藏窗口行为。

**需要验证：** 打印脱敏后的最终 command/args、解析出的 entry、pid；分别以 `opencode.cmd`、`opencode.exe`、`node .../opencode` 和裸 `opencode` 启动。

### H3：WSL 冷启动 / 路径 / MCP 探测超时（高概率，仅 WSL）

**依据：** daemon 注释明确说明 WSL 冷启动、宿主探活、配置迁移和 `spawn_pty` 需要长超时；当前 OpenCode 走通用 WSL supported CLI 分支。

**可观察结果：** Local 正常、WSL 卡住；日志停在 `resolve_wsl_launch`、reachable host、hook sync 或 WSL command build；daemon client 最终 60 秒超时。

**需要验证：** `wsl.exe -d <distro> -- true`、目标 distro 中 `type -a opencode`、目标 cwd 可写性、WSLENV 是否含必要的 `CC_PANES_*`，并在 `skipMcp=true` 下重复。

### H4：配置或项目插件写入造成启动阻塞/冲突（中概率）

**依据：** 当前 adapter 在每次 launch 读取多个用户/项目 config，并写 session config、TUI config、theme、plugin；参考项目也曾专门给 TUI config 加共享测试锁。

**可观察结果：** 同一项目并发打开多个 OpenCode 时更容易复现；删除 `.opencode/plugins/ccpanes.js` 或临时配置目录后恢复；日志停在 `write_session_*` 或 `sync_project_hooks`。

**需要验证：** 只读用户 config、检查 JSON/JSONC 解析错误、检查目录 ACL/杀毒软件锁定、并发启动两个 OpenCode、用原子临时文件 + rename 做实验。

### H5：React StrictMode / restore race 触发重复启动（中低概率）

项目文档已经记录 dev 模式下 React StrictMode 可能产生“创建即销毁” PTY。当前 pane 还有 launch id、restore barrier、expected saved session 和 deferred restore 多套防重逻辑。它更可能造成重复进程或状态覆盖，而不是单次 OpenCode 启动本身卡死，但必须在修复中加入重复创建回归测试。

### H6：OpenCode 自身等待认证、模型或网络（必须排除但不要误判为 CC-Panes 死锁）

OpenCode TUI 启动后可能等待 provider 登录、模型选择、网络请求或首次初始化。如果 PTY 已成功创建且有输出，只是 TUI 没进入可交互态，应归类为“CLI readiness / auth”问题；不能把所有无响应都归因于 Rust 锁或前端。

## 6. 四阶段复现与取证 runbook

### 阶段 1：先证明卡在哪一段

在 Windows 主机上，先保存当前日志和进程快照，不修改代码：

```powershell
where.exe opencode
Get-Command opencode -All | Format-List *
opencode --version
Get-Process opencode,node,cmd,wsl -ErrorAction SilentlyContinue |
  Select-Object Id,ProcessName,Path,StartTime,CPU
```

记录以下输入矩阵：

| Case | runtime | provider | MCP | hook | override | 目的 |
|---|---|---|---|---|---|---|
| A | local | none/native | off | off | none | 最小启动基线 |
| B | local | explicit | off | off | none | 验证 provider/config |
| C | local | explicit | on | on | none | 验证完整 CC-Panes 集成 |
| D | local | none/native | off | off | `opencode` | 验证裸命令 override |
| E | local | none/native | off | off | `C:\...\opencode.cmd` | 验证 `.cmd` override |
| F | WSL | none/native | off | off | none | 验证 WSL 基线 |
| G | WSL | explicit | on | on | none | 验证最复杂路径 |

### 阶段 2：验证 H1/H2，不先改业务逻辑

要求高级 AI 先增加或临时开启以下结构化日志，每条包含 `launchId`、`sessionId`、`cliTool`、`runtimeKind`、`projectPath`、`elapsedMs`：

```text
launch.begin
launch.profile.resolved
launch.provider.resolved
launch.mcp.resolved
launch.project_hooks.begin/end
launch.opencode_config.begin/end
launch.executable.resolved
launch.command.final
launch.pty.begin
launch.pty.spawned
launch.session.registered
launch.ready
launch.failed
launch.timeout
launch.cleanup.begin/end
```

最终 command/args 必须脱敏：MCP token、API key、system prompt、用户 prompt 不能进入日志。

### 阶段 3：验证 H3/H4

```powershell
wsl.exe -d <distro> -- true
wsl.exe -d <distro> -- sh -lc "type -a opencode; opencode --version"
wsl.exe -d <distro> -- sh -lc "test -d '<remote-project>' && test -w '<remote-project>'"
wsl.exe -d <distro> -- sh -lc "printf '%s\n' \"$WSLENV\""
```

检查：

- `<data-dir>/cli-adapters/opencode/<sessionId>/opencode.json`
- `<data-dir>/cli-adapters/opencode/<sessionId>/ccpanes-tui.json`
- `<project>/.opencode/plugins/ccpanes.js`
- 用户原生 `~/.config/opencode/opencode.json` / Windows 对应 config 目录是否被修改。

并发启动两个 OpenCode，确认两个 session 的配置文件路径、MCP URL、launch id、provider credentials 不串台。

### 阶段 4：确认“修复完成”而不是“看起来好了”

至少证明：

- A/G 两个最小基线都能在 deadline 内返回 session id。
- 每个失败分支都会显示错误面板，并可重试；不会永久停在 `Starting terminal`。
- 超时后后台没有残留的同一 launch 的 `opencode/node/cmd/wsl` 进程。
- Claude、Codex、plain shell 不受 OpenCode 配置注入影响。
- Native provider 模式不被 CC-Panes provider 或 `OPENCODE_CONFIG` 静默接管。
- 多次快速点击、React StrictMode、布局切换、关闭 pane 都不会产生重复 PTY。

## 7. 推荐修复边界

### 7.1 必须做

1. 统一启动 deadline：普通新建、恢复、重连、后台布局恢复、编排器 launch 都要有一致语义；建议后端返回明确的 `LaunchTimeout` 错误码，前端将其映射为可重试错误面板。
2. 阶段化日志和 launch id 贯穿：不要只打印“spawn failed”，要能知道停在 profile、config、WSL、executable、PTY 哪一段。
3. 超时清理：如果 session 已注册，按 `launchId/sessionId` 幂等 kill；如果只拿到 child pid，也必须有安全的进程树清理和 PID 身份校验。
4. 统一 Windows command resolver：默认命令和显式 override 都要验证 `.cmd/.bat/.exe/Node entry`，不能让裸 `.cmd` 直接落到 ConPTY CreateProcess。
5. 配置写入原子化：写到同目录临时文件、flush、rename；失败时保留原文件；session config 与 TUI config 使用独立路径；项目插件只覆盖 CC-Panes 自己写入的内容。
6. OpenCode 附加能力降级：MCP、theme、hook、provider 注入失败时，必须明确记录并按策略选择“阻止启动”或“无该能力启动”，不能无限等待。
7. 至少补齐单元、集成和手工验收用例，覆盖 Local/WSL、native/managed、默认/override、MCP on/off、并发和超时清理。

### 7.2 不要做

- 不要为了规避卡死把 OpenCode 改成 `run`、`serve` 或 ACP，除非复现证明当前 TUI 命令本身错误。
- 不要直接删除 OpenCode 的 session/config/provider 能力来“让它先启动”。
- 不要把所有用户 config 复制到一个永久全局文件并覆盖原生 OpenCode 配置。
- 不要只在前端 `Promise.race`，却不清理后端已经启动的 PTY。
- 不要把 WSL/Windows 现象混为一谈，也不要从 WSL 运行结果宣称 Windows WebView2/ConPTY 已验证。

## 8. 可直接交给高级 AI 的一轮修复提示词

下面的提示词可原样交给负责实现的高级 AI。它要求先复现和定位，再做最小范围修复；如果证据表明根因不同，必须以日志为准调整方案。

```text
你现在负责修复 CC-Panes 中“OpenCode 启动容易卡死/永久停在 Starting terminal”的问题。

目标仓库：F:\C26\demo\cc-pane
只读参考仓库：F:\C26\gitee.com\zhengjunkj\ccpanel
参考仓库绝不修改、格式化、提交或清理。

你必须遵守：
1. 先读目标仓库的 AGENTS.md/CLAUDE.md、README、package.json、Cargo.toml 和当前 git diff。
2. 先做四阶段调试：重现 -> 假设 -> 验证 -> 修复。根因未被日志或测试确认前，不要大规模改代码。
3. 保留现有用户改动，不使用 git reset、git checkout、git clean 或覆盖式复制。
4. 不要把 OpenCode 改成另一种产品模式来规避问题；保留 TUI、resume、provider、MCP、Native/Managed 语义。
5. 所有最终日志必须脱敏，不能记录 API key、MCP token、完整 prompt 或用户凭据。
6. Windows 桌面行为必须标注为 Windows-host-required；Linux/WSL 只能做静态或逻辑验证。

已知代码线索（执行时重新读取，行号不是永久契约）：
- 普通新建终端在 web/components/panes/TerminalView.tsx 直接 await terminalService.createSession；没有普通启动 timeout。
- 只有 web/components/panes/terminalRestoreQueue.ts 对恢复启动提供 45s timeout。
- src-tauri/src/commands/terminal_commands.rs 把创建放入 spawn_blocking。
- cc-panes-core/src/services/daemon_client.rs 的 daemon create read timeout 为 60s，但它不能取消已经运行的同步 spawn_blocking，也不能自动清理迟到的 PTY。
- cc-panes-daemon/src/server.rs 的 POST /api/sessions 也把 backend.create_session 放入 spawn_blocking。
- cc-panes-core/src/services/terminal_service.rs 在 spawn_pty 之前执行 profile/provider/MCP/hook/config/WSL/SSH 等工作。
- cc-cli-adapters/src/opencode.rs 会生成 OPENCODE_CONFIG、OPENCODE_TUI_CONFIG，并可能同步写项目插件/主题。
- cc-cli-adapters/src/lib.rs 已有 resolve_executable 与 Windows npm shim 重写历史；必须验证显式 launcher override 是否绕过了安全解析。
- web/components/panes/TerminalTabContent.tsx 在“无 sessionId 且无 launchError”时一直显示 Starting terminal。

工作阶段 A：取证，不改业务逻辑
1. 记录 git status --short、当前分支、最近 20 个相关提交。
2. 搜索所有 create_terminal_session/createSession/create_session/spawn_pty/opencode/resolve_launch/launchError/terminalRestoreQueue 代码。
3. 给启动链补最小结构化阶段日志或测试钩子，字段至少包含 launchId、sessionId、cliTool、runtimeKind、stage、elapsedMs、outcome。
4. 记录脱敏后的最终 command、args、executable path、是否 .cmd/.bat/.exe、cwd 和 env key 名；绝不打印 secret value。
5. 用下列矩阵复现：
   A local + native/no provider + skipMcp=true + no hook
   B local + explicit provider + no MCP
   C local + explicit provider + MCP/hook/prompt
   D local + command override=opencode
   E local + absolute opencode.cmd override
   F WSL + native/no provider + skipMcp=true
   G WSL + explicit provider + MCP/hook
6. 明确每个 case 停在 profile/provider、MCP、hook、config、executable、WSL、PTY 还是 OpenCode 已启动后的 readiness。

工作阶段 B：建立并验证假设
按概率验证，至少覆盖：
H1：普通启动缺少 deadline，后端阻塞导致 UI 永远等待。
H2：Windows npm shim/custom override 没有统一转成可执行的 native exe 或 node entry。
H3：WSL 冷启动/路径/MCP host 探测超过预期，daemon timeout 后没有清理迟到的 session。
H4：OpenCode config/theme/plugin 同步 I/O 或并发写入阻塞/冲突。
H5：React StrictMode、布局切换、restore/retry 造成重复 launch 或状态覆盖。
H6：PTY 已经启动，OpenCode 自己在认证/模型/网络等待，不能误判成 Rust 死锁。

每个假设都必须给出：
- 代码依据；
- 可重复的命令或测试；
- 成立时预期看到的日志；
- 不成立时如何排除。

工作阶段 C：实施最小但完整的修复
优先完成以下能力：
1. 为普通新建、恢复、重连和后台恢复统一启动 deadline；不要只在前端 Promise.race。
2. 超时时发出结构化 launch.timeout/launch.failed 事件，并让前端进入现有 LaunchErrorPanel 可重试状态。
3. 超时后按 launchId/sessionId 做幂等 cleanup；确保晚到的 backend response 不会把已失败 pane 重新绑定，也不会留下孤儿 opencode/node/cmd/wsl 进程。
4. 统一默认 executable 与显式 override 的 Windows 解析：
   - .exe 原生入口直接运行；
   - npm .cmd/.bat 解析到真实 native entry 或 node + JS entry；
   - 无法解析时显式返回可读错误，不要静默卡住；
   - 对绝对路径和裸命令都写回最终 command/args 的脱敏日志。
5. 将 OpenCode config/tui/plugin 写入改成原子写入；隔离每个 session 的路径；不修改用户原生配置；明确哪些失败可降级、哪些必须阻止启动。
6. 对 WSL 探测和 hook/config 辅助步骤增加有界超时或可取消边界；若 MCP 不可达，按既有 skip/degrade 语义继续启动，并给出 warning。
7. 保留 Claude/Codex/plain shell 行为不变。不要顺手重构 terminal service 或输出渲染器。

工作阶段 D：测试和验证
必须新增或修改测试，至少包括：
- 普通启动 Promise 超时后进入 launch error；
- timeout cleanup 不会重复 kill、不残留 session；
- late create response 不会重新绑定已失败 pane；
- Windows command resolver 覆盖 bare opencode、opencode.cmd、opencode.exe、node entry、invalid override；
- OpenCode config 原子写入、并发 session 隔离、原生 config 不被覆盖；
- skipMcp/no-provider 最小路径仍能构建命令；
- WSL/daemon timeout 错误包含 runtime、stage 和 launch id；
- React StrictMode/retry/layout switch 不产生重复 PTY。

建议验证命令（按仓库实际脚本调整）：
npx tsc --noEmit
npm run test:run -- web/components/panes web/services
cargo fmt --all -- --check
cargo test -p cc-cli-adapters
cargo test -p cc-panes-core
cargo test -p cc-panes-daemon
cargo check --workspace

Windows 主机手工验收：
1. where.exe opencode / Get-Command opencode -All / opencode --version。
2. A-G 启动矩阵各跑至少 3 次。
3. 失败时必须在 deadline 内出现错误面板和 Retry。
4. 超时后检查 Get-Process opencode,node,cmd,wsl，确认没有同一 launch 的孤儿。
5. 关闭/重试/切换布局/重启应用后，session、pane、launch history 一致。
6. Claude、Codex、plain shell 各启动一次，确认未被 OpenCode env/config 影响。

最终回复必须包含：
- 已确认根因和证据，不要只写“可能是”；
- 修改文件及每个文件的职责；
- timeout/cancel/cleanup 语义；
- Native/Managed、Local/WSL/SSH 兼容矩阵；
- 测试命令与实际结果；
- Windows 主机尚未验证的项目；
- 未解决风险和后续建议。
不要提交 Git，不要修改参考仓库。
```

## 9. 验收标准

### 9.1 功能标准

- 本地 OpenCode 无 provider、无 MCP、无 hook 可以在正常 deadline 内启动。
- 本地 OpenCode explicit provider 可以在正常 deadline 内启动，且只使用本次选择的 provider。
- WSL OpenCode 在可接受冷启动时间内启动；不可达 MCP 不会让整个 TUI 永久卡住。
- 使用裸命令、绝对 `.cmd`、绝对 `.exe`、Node entry 的 launcher override 都有确定结果。
- OpenCode resume 失败时显示明确错误，不会无限等待。

### 9.2 生命周期标准

- 启动超时后 pane 可重试、可关闭。
- timeout、失败、取消、迟到成功四种事件都有明确状态转换。
- 失败启动不会留下孤儿进程、永久 launch history pending 或重复 session。
- 同一个 launch id 最多绑定一个 live session。

### 9.3 回归标准

- Claude、Codex、Gemini、plain shell 的启动和输出不回归。
- terminal restore queue 的 45 秒行为保持有效；普通启动拥有同等的错误收敛能力。
- OpenCode 用户原生配置、theme、keybind、MCP 不被静默覆盖。
- 输出洪水、alternate buffer、WebGL、终端关闭清理等已有修复不被回退。

## 10. 当前未验证项目

以下内容不能仅凭当前代码检查宣布“已验证”：

- Windows WebView2 下真实按钮点击到 PTY 首屏的时序。
- Windows ConPTY 对 `.cmd`、Node shim、原生 OpenCode binary 的具体行为。
- WSL 发行版冷启动、代理、宿主可达性和 OpenCode 安装来源。
- 用户本机 OpenCode 版本、provider 登录状态、杀毒软件/文件锁行为。
- daemon 超时后迟到 response 与孤儿 PTY 的真实现场。

这些必须在 Windows 主机上运行本文件的复现矩阵，并保留脱敏日志、进程快照和退出码。
