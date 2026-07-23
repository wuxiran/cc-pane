# 46 — Mac 打开含 Windows 路径的工作空间,启动 CLI 黑屏无报错

> 状态:已定位待修(Worker G 执行依据,可与 docs/45 同 worker 顺做)。

## 现象

macOS 上打开一个项目路径为 Windows 形式(`D:\...`)的工作空间,启动 Codex/终端 → 标签页黑屏,无任何错误提示。

## 已查实的传播链

- `create_session`(terminal_service.rs:1268)对 cwd **无 exists/is_dir 校验、无平台判断**;`normalize_session_request_for_current_host`(launch_request.rs:3-36)只在宿主运行于 WSL 内时转换 Windows 路径,mac 上 `D:\...` 原样透传。
- cwd → `PtyConfig` → `spawn_pty`(pty/mod.rs:133)→ `spawn_command` 因 cwd 不存在返回 Err(terminal_service.rs:1933 "PTY spawn FAILED")→ `create_session` 抛错。
- web 路由(cc-panes-web/src/routes/terminal.rs:166-175)把 Err 压成不透明 `500 "Failed to create session"`,真实原因只进服务端日志;前端已乐观建 tab 但拿不到 session_id 与输出 → **黑屏 + 一条含糊 toast**。

## 修复要求(已按文末 Codex 分析结论修正,以其第 5 节最小修复集为准)

> 原始链路判断有两处被 Codex 纠正:①portable-pty 0.8.1 在 Unix 对无效 cwd **静默回退 HOME**
> 而非 spawn 失败——"PTY spawn FAILED"链不成立,Mac 真实失败点是 `validate_path` 的
> `PATH_NOT_ABSOLUTE`(`D:\...` 在 Unix 非绝对路径);②HOME 回退是**全平台暗雷**
> (Windows 路径不存在时会话静默启动在用户目录,agent 在错误目录干活)。

1. **共享 host/path 分类器 + local 有效 cwd 校验**:对实际 spawn 用的 `workspace_path.unwrap_or(project_path)` 区分"宿主平台不匹配(Windows 盘符路径在非 Windows)/不存在/非目录/无权限",平台不匹配检测须早于通用 `PATH_NOT_ABSOLUTE`(否则 Mac 只得到技术性文案);**SSH 排除本地路径校验**(远端目录错误由远端 cd 输出体现);非 Windows 的 WSL 保留明确 unsupported。
2. **封死 portable-pty 回退**:`spawn_pty` 紧邻 spawn 前再做一道不回退校验(拒绝不存在/非目录 cwd)——早入口检查有 TOCTOU,且 Web/daemon/orchestrator 可绕开 Tauri 校验;不能依赖 portable-pty 报错,它的既定行为就是回退 HOME。Windows 同样断言不会回退 USERPROFILE。
3. **错误可见化拆通道**:Web 路由停止固定 500,透传具体错误;Tauri 已透传结构化 AppError,缺口在前端——tab/terminal leaf 持久保存 `launchError`(code/message/params),以独立错误面板显示翻译后的原因 + 重试/移除按钮;toast 仅辅助。
4. **入口预防**:侧栏/全局启动器/空态/最近启动/恢复快照/orchestrator 各启动入口复用同一分类器,创建 tab 前对明显跨平台 local 路径禁用或警示;后端校验仍是兜底不变量。
5. 测试矩阵(无需 Mac):非 Windows 宿主 + 盘符路径→platform mismatch;不存在绝对路径→not found;普通文件→not directory;SSH 不走本地存在性;非 Windows WSL→unsupported;spawn_pty 对无效 cwd 在 spawn 前报错(两平台);前端 mock reject 断言错误态/重试/移除;Web 路由透传断言。

## 验证

- 手工(可在 Windows 模拟):对不存在的路径启动 → tab 显示明确错误而非黑屏;错误文案含具体原因。
- mac 侧最终验证由用户执行。

## 请 Codex 交叉分析的问题(只读,结论追加到文末「Codex 分析结论」)

1. **Mac 桌面端的真实错误链**:上面查的吞错点在 cc-panes-web 路由(terminal.rs:166-175),但 Mac 桌面 app 走 **Tauri IPC**——核实 `create_terminal_session` Tauri 命令(src-tauri/src/commands/terminal_commands.rs)失败时错误如何回前端、前端 `terminalService.createSession` 的 catch 链路、tab 乐观创建后失败时的 UI 状态。黑屏在 Tauri 路径是否同样成立?若前端有 toast,为何用户感知是"黑屏无法启动"?
2. **为什么只在 Mac 发现**:Windows 上启动不存在路径是否同样黑屏(即 bug 是全平台的,只是 Mac 用户先踩到)?还是 Mac 有额外分支(如 spawn cwd 行为差异、login shell 差异、`\\?\`/盘符路径在 Unix spawn 中的解释差异——`D:\...` 在 Unix 可能被当相对路径而非直接报错,导致进程"成功启动在错误目录"或行为不同)?特别核实:portable-pty 在 Unix 对不存在 cwd 是 spawn 失败还是回退?
3. **WSL/SSH 分支**:Mac 上该工作空间如果配了 WSL(Mac 无 WSL)/SSH 环境,launch 链会在哪一步失败,表现是否也是黑屏?
4. 复核 docs/46 修复要求 1-3 是否覆盖 Mac 场景,补充遗漏(如 mac 上 `wsl.exe` 不存在时 runtimeKind=wsl 的行为)。
5. 给出你认为的最小修复集与验证方式(Mac 无法本地复现时,在代码层面给出可信度评估)。

## Codex 分析结论

> 基于 2026-07-24 当前源码与锁定依赖交叉核对。先纠正上文一个关键判断：
> `portable-pty 0.8.1` 在 Unix 上不会把无效 cwd 原样交给 `spawn`，而会静默回退到
> HOME；因此“cwd 不存在必然触发 `PTY spawn FAILED`”不成立。

### 1. Mac 桌面端的真实错误链

1. 桌面端先在 Store 中同步创建 tab，初始 `sessionId` 为 `null`
   (`usePanesStore.ts:83-124,1561-1572`)，随后 `TerminalView` 才异步创建后端会话。
2. `terminalService.createSession` 经 `invokeOrApi` 检测到 Tauri 后直接调用
   `invoke("create_terminal_session", ...)`，没有经过 Web 路由，也没有在 service 层
   catch/改写错误(`terminalService.ts:494-510`, `apiClient.ts:8-17`)。
3. `create_terminal_session` 在调用 core 前会执行 `validate_path`
   (`terminal_commands.rs:82-126`)。该校验只检查非空、无 `..`、以及当前宿主语义下的
   `Path::is_absolute`，不检查存在性/目录性(`path_validator.rs:7-40`)。在 macOS 的 Unix
   路径语义下，`D:\...` 不是绝对路径，所以本例会先返回结构化
   `PATH_NOT_ABSOLUTE`，通常根本到不了 `TerminalService::create_session` 和 PTY spawn。
4. `AppError` 被 Tauri 序列化为 `{ code?, message, params? }`
   (`error.rs:75-89`)；前端 Promise 会 reject 这个对象。`TerminalView` 的 catch 用
   `getErrorMessage` 取出 `message`，然后向 xterm 写一行红色
   `Failed to initialize terminal session: ...`(`TerminalView.tsx:1726-1767`)。
   现有单测也明确断言 createSession reject 后会写出该行
   (`TerminalView.test.tsx:393-405`)。

**结论**：Tauri 路径没有像 Web 路由一样吞成固定 500，且源码预期并非“绝对无报错”。
但失败后 `onSessionCreated` 不会执行，tab 的 `sessionId` 一直为 `null`；catch 不关闭 tab、
不记录可渲染的失败状态、没有重试/移除动作，也没有针对本次失败的 toast。用户看到的仍是
一个占满黑底、无法交互的死 tab，唯一反馈依赖 xterm 内的一行文字。因此“黑屏无法启动”的
产品感知成立，但“完全没有文字”不能仅由当前源码推出；若 Mac 现场确实零文字，还需在 Mac
WebView 中确认该 `term.writeln` 是否实际渲染。侧栏对已知环境问题会 toast，不等于
`createSession` catch 有 toast。

### 2. 为什么目前只在 Mac 发现，以及 portable-pty 的真实行为

- 仓库锁定的是 `portable-pty 0.8.1`(`Cargo.lock:5139-5156`)。其 Unix
  `CommandBuilder::as_command` 对请求 cwd 执行 `is_dir()`；不是目录时直接选择 HOME，
  再把这个回退目录传给 `std::process::Command::current_dir`
  (`portable-pty-0.8.1/src/cmdbuilder.rs:452-478`)。所以在通常 HOME 有效的情况下，
  **不存在 cwd、普通文件 cwd、以及 Unix 下的 `D:\...` 都不会因 cwd 本身导致 spawn
  失败，而会在 HOME 启动**。只有回退 HOME 本身也无效等情况才可能在 spawn 阶段失败。
- Windows 实现同样先过滤无效 cwd，并优先回退到有效 `USERPROFILE`；两者都不可用时
  `CreateProcessW` 收到空 cwd，继承父进程目录
  (`portable-pty-0.8.1/src/cmdbuilder.rs:560-585`)。所以 Windows 上“不存在路径”也不一定
  黑屏，更可能静默在用户目录/父进程目录启动。
- 真正的 Mac/Windows 差异发生得更早：`D:\...` 在 Windows 是绝对路径，在 macOS 是
  相对路径。Mac Tauri 命令因此返回 `PATH_NOT_ABSOLUTE`；Windows 会通过当前语法校验。
  若原 Windows 路径真实存在，Windows 正常启动而 Mac 必然失败；若 Windows 上也不存在，
  portable-pty 的回退还可能把问题隐藏掉。这足以解释为何先在 Mac 暴露，不应归因于
  Unix `chdir` 更严格。
- `D:\...` 在 Unix 的确会被 `Path` 当相对路径，但正常桌面链路在 Tauri 校验处已经拒绝；
  只有绕过该命令边界的 core/Web 调用才会走到 portable-pty，届时通常回退 HOME。
  login shell 也不是本例主因：显式 Codex/Claude 启动会直接解析并 spawn CLI；只有纯 shell
  启动才使用默认 login shell。

因此该问题包含两个相关但不同的缺陷：**跨平台路径未在入口给出正确诊断**，以及
**portable-pty 的 cwd 静默回退未被应用层阻断**。后者是全平台风险，可能表现为“启动成功但
项目上下文错误”，不一定表现为黑屏。

### 3. WSL / SSH 分支

- **WSL**：正常工作空间启动解析已经在非 Windows 平台返回 `wsl_unsupported`，不会创建
  tab(`workspaceLaunch.ts:280-285`)。但旧快照、恢复 tab 或直接 IPC 仍可能携带 `wsl`。
  此时如果 `projectPath/workspacePath` 仍是 Windows 路径，Mac 会先在 Tauri
  `validate_path` 返回 `PATH_NOT_ABSOLUTE`；若二者是 Mac 可接受的绝对路径，core 的
  `resolve_wsl_launch` 在 `cfg(not(windows))` 分支明确返回
  `WSL launch is only supported on Windows`(`wsl_codex.rs:792-799`)。Mac 不会真的尝试查找或
  执行 `wsl.exe`。失败最终仍落到上述 xterm 红字 + 无 sessionId 的死 tab；恢复路径会额外
  标记 restore failed，但仍缺少统一错误面板。
- **SSH**：这是 Mac 上合法的远程替代路径。Tauri 对 SSH 请求只校验 SSH 连接信息，不校验
  本地显示用的 `projectPath/workspacePath`；core 使用本机 HOME 作为 PTY cwd，并执行本机
  `ssh`(`terminal_service.rs:1585-1598,3029-3079`)。若本机无 `ssh`，createSession 会 reject；
  若远端目录不存在，SSH 进程本身已经创建成功，远端 `cd ... && <cli>` 会在终端输出错误并
  退出，而不是 createSession 阶段失败。故 SSH 不应套用 local cwd 校验，也不能仅靠本地
  `Path::exists` 判断远端目录。

### 4. 对修复要求 1-3 的复核与补充

1. **要求 1 方向正确，但校验对象应是 local runtime 的有效 cwd**：当前真正用于 spawn 的是
   `workspace_path.unwrap_or(project_path)`(`terminal_service.rs:1794-1799`)。应区分
   “宿主平台不匹配”“不存在”“存在但不是目录”“无权限/无法读取”，且平台不匹配检测要早于
   现有通用 `PATH_NOT_ABSOLUTE`，否则 Mac 仍只得到技术性文案。SSH 必须排除；WSL 在非
   Windows 上应保留明确的 unsupported 错误。
2. **还需在 `spawn_pty` 前做最后一道不回退校验**。仅在较早入口检查存在 TOCTOU，且
   Web/daemon/orchestrator 等调用可能绕开 Tauri 校验。应用层必须在设置 `CommandBuilder.cwd`
   前拒绝无效目录，不能依赖 portable-pty 报错，因为该依赖的既定行为就是回退 HOME。
3. **要求 2 应拆分通道**：Web 路由确实需要停止固定返回
   `500 Failed to create session`；Tauri 已能透传结构化 `AppError`，缺口是前端 catch 把错误
   降成 message 并只写 xterm。tab/terminal leaf 应持久保存启动失败状态，以独立 UI 显示
   翻译后的原因、重试和移除按钮；toast 只能做辅助提示，不能作为唯一错误面。
4. **要求 3 有价值但不能替代后端不变量**。当前 local 分支只检查 path 是否非空，未检查
   路径形态与宿主平台(`workspaceLaunch.ts:265-278,379-418`)。侧栏、全局启动器、空态按钮、
   最近启动、恢复快照和 orchestrator 都可能成为入口，需复用同一个判定工具，且后端仍要兜底。
5. 无需在 Mac 专门捕获“`wsl.exe` 不存在”：非 Windows core 分支已经编译为明确的 WSL
   unsupported 错误。需要补的是让旧 tab/直接 IPC 也把这个结构化错误显示成稳定错误态。

### 5. 最小修复集、验证方式与可信度

**最小修复集**：

1. 增加共享的 host/path 分类与 local 有效 cwd 校验，并在 `create_session` 给出结构化错误；
   在 `spawn_pty` 紧邻 spawn 再拒绝不存在/非目录 cwd，封死 portable-pty 回退。
2. Tauri 保持现有结构化错误透传；Web 路由返回具体错误；前端为 tab/terminal leaf 增加
   `launchError`（保留 code/message/params）和稳定错误面板，接通重试/移除。
3. 各启动入口复用 host/path 分类器，在创建 tab 前禁用或提示明显的跨平台 local 路径；
   保留 SSH 可启动，保留非 Windows WSL 禁用。

**无需 Mac 的自动验证**：

- Rust 路径矩阵：非 Windows 宿主 + Windows 盘符路径 => platform mismatch；不存在绝对路径
  => not found；普通文件 => not directory；临时目录 => 通过；SSH 不走本地路径存在性校验；
  `cfg(not(windows))` 的 WSL => unsupported。
- PTY 回归：直接给 `spawn_pty` 不存在/普通文件 cwd，断言在 spawn 前返回错误而不是在 HOME
  启动；Windows 同样断言不会回退 `USERPROFILE`。
- Tauri/前端：mock `{ code, message, params }` reject，断言 tab 保留明确错误态、没有 sessionId，
  重试会重新调用 createSession，移除会关闭 tab；Web 路由断言响应保留具体错误。
- 启动入口：macOS + `D:\repo` local 被禁用并显示平台不匹配；macOS + SSH 仍可启动；macOS +
  WSL 仍为 unsupported。

**最终验证边界**：源码层面对 Tauri 错误链、Unix 路径语义和 portable-pty 回退行为的判断为
高可信；Linux 可覆盖绝大多数 Unix 分支。对“Mac WebView 中错误行为何完全不可见”的判断仅为
中等可信，因为当前代码和单测都表明应该写入一行错误，仍需 Mac 桌面端手工确认最终错误面板、
WebView 渲染及真实启动行为。Windows 侧还应确认旧行为确实不再静默落到用户目录。
