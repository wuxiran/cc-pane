# 终端本地路径 Link 点击弹窗 - 可靠实现提示词

> 调研日期：2026-08-05  
> 目标仓库：`F:\C26\demo\cc-pane-new`  
> 参考仓库：`F:\C26\gitee.com\zhengjunkj\ccpanel`  
> 用途：把本文「可复制提示词」完整交给编码代理，在目标仓库实现功能。

## 使用方法

复制 `[IMPLEMENTATION PROMPT BEGIN]` 到 `[IMPLEMENTATION PROMPT END]` 之间的全部内容。提示词要求执行者先核对代码现状，再实施、测试和报告；不要只让执行者输出方案。

## 可复制提示词

[IMPLEMENTATION PROMPT BEGIN]

# 任务：实现终端本地路径 Link 点击弹窗

你正在修改 CC-Panes：

- 仓库：`F:\C26\demo\cc-pane-new`
- 技术栈：React 19、TypeScript、Zustand、xterm.js 6、Tauri 2、Rust、可选 daemon、Web 访问
- 参考实现：`F:\C26\gitee.com\zhengjunkj\ccpanel`
- 参考提交：`f86fa96`（路径识别）和 `57cf8df`（点击弹窗）

完成一个端到端功能：终端输出中的本地文件或目录路径显示为可点击 Link；用户点击后先弹出操作对话框，再选择在内置编辑器打开、使用系统默认程序打开、在文件管理器中显示或复制规范路径。路径可带 `:line[:column]`，在内置编辑器打开时定位到对应位置。

这不是照搬参考仓库。必须适配当前仓库的 service 层、TerminalView 生命周期、daemon/web 后端边界、现有 Radix Dialog 和编辑器 tab 模型。

## 1. 开始前必须读取

先读根目录 `AGENTS.md`、`CLAUDE.md` 和以下代码。若行号已经漂移，以符号和职责为准：

- `web/components/panes/TerminalView.tsx:829`：xterm 创建、addon 注册和销毁生命周期
- `web/components/panes/TerminalView.test.tsx:25`：xterm 测试替身
- `web/components/layout/AppDialogs.tsx:19`：全局 Dialog 挂载点
- `web/components/ui/dialog.tsx:10`：Radix Dialog 封装
- `web/stores/editorTabActions.ts:67`：`openEditor` 入口
- `web/stores/panesStoreTypes.ts:223`：`openEditor` 类型契约
- `web/components/editor/EditorView.tsx:92`：Monaco 编辑器
- `web/components/editor/EditorView.tsx:259`：Monaco `onMount`
- `web/services/filesystemService.ts:11`：`invokeOrApi` service 模式
- `web/services/terminalService.ts:1`：终端 service 和 web/desktop 分流模式
- `cc-panes-core/src/services/terminal_service.rs:760`：进程内 `TerminalSession`
- `cc-panes-core/src/services/terminal_service.rs:1385`：创建会话时已有 `project_path` 和运行时信息
- `cc-panes-core/src/services/terminal_service.rs:2412`：会话写入内存表
- `cc-panes-core/src/services/terminal_backend.rs:49`：`TerminalBackend` 边界
- `cc-panes-core/src/services/terminal_backend.rs:602`：daemon provenance 查询
- `cc-panes-core/src/models/session_restore.rs:10`：`TerminalSessionProvenance`
- `src-tauri/src/commands/terminal_commands.rs:151`：Tauri 终端命令模式
- `src-tauri/src/commands/filesystem_commands.rs:10`：文件系统命令模式
- `src-tauri/src/lib.rs:2347`：Tauri command 注册
- `cc-panes-web/src/routes/terminal.rs`：Web 终端路由模式
- `cc-panes-web/src/routes/resources.rs:612`：Web 文件系统路由模式
- `web/i18n/locales/en/panes.json:164`
- `web/i18n/locales/zh-CN/panes.json:164`

再读取参考仓库中的：

- `changes/terminal-local-path-links/{proposal.md,design.md,specs/terminal-local-path-links.md,tasks.md}`
- `src/lib/terminalPathLink.ts`
- `src/lib/__tests__/terminalPathLink.test.ts`
- `src/store/terminalPathLinkStore.ts`
- `src/components/TerminalPathLinkModal.tsx`
- `src-tauri/src/commands/file_ops.rs:21`

读取后先用 8 行以内记录：当前接入点、计划新增文件、会修改的既有文件、运行时范围。随后直接实施，不要停在方案阶段。

## 2. 用户行为契约

### 2.1 识别范围

首版支持：

1. Windows 绝对路径：`F:/work/report.md`、`F:\work\report.md`
2. POSIX 绝对路径：`/Users/dev/work/report.md`，仅宿主系统能直接解析时启用
3. 项目相对路径：`./docs/report.md`、`../shared/report.md`、`src/App.tsx`
4. 可选位置后缀：`:line` 或 `:line:column`，行列均为从 1 开始的正整数
5. xterm 软换行拆开的同一个路径
6. OSC 8 `file://` 本地链接，走同一解析和弹窗流程
7. 文件与目录目标

首版不支持：

- SSH 远端文件系统路径
- Windows 宿主上的 WSL POSIX 绝对路径，例如 `/home/user/repo/a.ts`
- UNC 绝对路径文本、远端 `file://host/...`、非 `localhost` file URI
- 硬换行两侧文本的猜测拼接
- glob、source map、虚拟文件、未落盘文件
- `mailto:`、`javascript:`、`ftp:` 或其他非 HTTP(S)/file URI

相对路径中的 `..` 可以出现，但规范化后的目标仍必须位于来源终端的项目根目录内。

### 2.2 点击流程

1. 鼠标经过语法匹配的路径时显示指针和下划线。
2. 点击 Link 立即打开 Dialog，先显示用户点击的原始路径和解析中状态。
3. 前端通过 service 发送 `sessionId + rawPath`；不能发送一个由前端声明的可信根目录。
4. 后端从来源 session 推导项目根和运行时，规范化并授权目标。
5. 解析成功后，Dialog 显示规范绝对路径、文件或目录类型、可选行列。
6. 解析失败时关闭 Dialog，并显示本地化 toast；终端输入、选择和文件系统保持不变。
7. 只允许一个路径 Dialog。连续点击时使用单调递增 `requestId`，旧请求不得覆盖新请求。

不要在 hover 或 `provideLinks` 阶段访问文件系统。xterm 只做有界的语法检测和 range 映射，存在性与权限在点击后检查。这样可以避免不可信终端输出通过鼠标移动制造大量 IPC，也避免异步 `provideLinks` 多次 callback 的竞态。

### 2.3 Dialog 动作

文件目标：

- 主操作「在编辑器中打开」：复用 `usePanesStore.openEditor`，并定位行列
- 「默认程序打开」：仅 Tauri 桌面显示
- 「在文件管理器中显示」：仅 Tauri 桌面显示
- 「复制路径」：复制后端返回的规范路径

目录目标：

- 主操作「在文件管理器中打开」：仅 Tauri 桌面显示
- 「复制路径」
- 不显示或禁用「在编辑器中打开」和「默认程序打开」

Web 访问：

- 文件显示「在编辑器中打开」和「复制路径」
- 目录只显示「复制路径」
- 不渲染注定失败的系统程序和文件管理器动作

操作请求期间防止重复提交。用户可以关闭 Dialog；关闭后任何迟到的 resolve 结果不得重开 Dialog。系统打开动作在后端执行前必须重新解析和授权原始 `sessionId + rawPath`，不能直接信任 Dialog 保存的规范路径。

### 2.4 终端回归约束

- 点击普通终端区域仍聚焦终端。
- 拖动选择路径仍可使用现有复制功能。
- 路径 Link 不拦截右键菜单、粘贴、IME、TUI 鼠标模式或键盘输入。
- 同一个 xterm 实例只注册一次 provider；重建、休眠唤醒和卸载时释放 `IDisposable`。
- 不为了 Link 重建 xterm，不改 PTY resize、输出缓冲、WebGL 或恢复时序。
- OSC 8 HTTP(S) 链接维持当前行为。不要顺便引入 `@xterm/addon-web-links` 或扩大普通 URL 功能范围。

## 3. 运行时矩阵

| 运行时 | 路径识别 | 后端授权根 | 可用动作 |
|---|---|---|---|
| Local Desktop | Windows/POSIX 宿主路径 + 相对路径 | 活跃 session 的 `projectPath` | 编辑器、默认程序、文件管理器、复制 |
| WSL Desktop | 相对路径；Windows 可解析的项目内绝对路径 | session 的宿主侧 `projectPath`，可为 WSL UNC 根 | 编辑器、默认程序、文件管理器、复制 |
| SSH | 不注册本地路径 provider，后端也必须拒绝 | 无 | 无本地文件动作 |
| Web + Local/WSL | 与服务端宿主可解析能力一致 | Web server 所连接 session 的项目根 | 编辑器、复制 |
| 星标镜像/只读终端 | 可以点击，但仍按原 session 授权 | 原 session 项目根 | 同对应运行时 |

WSL 首版不做 `/home/...` 到 `\\wsl.localhost\...` 的映射。相对路径可以基于已存在的宿主侧项目根工作。SSH 路径不能降级成宿主本地路径。

## 4. 推荐数据流

```text
xterm buffer
  -> pure parser + ILinkProvider
  -> click(rawPath, line, column, sessionId)
  -> terminalPathLinkStore: resolving(requestId)
  -> terminalPathLinkService.resolve()
  -> Tauri command / Web API
  -> TerminalBackend.terminal_link_context(sessionId)
  -> core resolver: canonicalize(root + target) + containment + file type
  -> terminalPathLinkStore: ready
  -> Radix Dialog
  -> editor reveal / copy / backend desktop action
```

保持以下分层：

- 纯语法和 xterm range：前端 `lib`
- Tauri/Web 调用：前端 `services`
- Dialog 状态：Zustand store
- UI：React 组件
- 授权和规范化：`cc-panes-core`
- IPC/HTTP 适配：`src-tauri` 与 `cc-panes-web`

组件和 store 不得直接调用 `invoke()`。不要把这组方法塞入语义无关的 `providerService`。

## 5. 前端实现要求

### 5.1 纯解析器和 LinkProvider

建议新增：

- `web/lib/terminalPathLink.ts`
- `web/lib/terminalPathLink.test.ts`

导出最小接口：

```ts
export interface TerminalPathReference {
  text: string;
  path: string;
  line?: number;
  column?: number;
}

export interface TerminalPathLinkOptions {
  allowPosixAbsolute: boolean;
}

export function parseTerminalPathReference(
  text: string,
  options: TerminalPathLinkOptions,
): TerminalPathReference | null;

export function findTerminalPathLinks(
  text: string,
  options: TerminalPathLinkOptions,
): Array<TerminalPathReference & { startIndex: number; endIndex: number }>;

export function classifyOsc8TerminalLink(
  uri: string,
  options: TerminalPathLinkOptions,
):
  | { type: "local"; reference: TerminalPathReference }
  | { type: "external"; url: string }
  | null;
```

实现一个 `ILinkProvider`，但不要把文件系统访问塞进去。要求：

- 每次最多检查 2048 个字符、返回最多 16 个候选
- 只合并 xterm `isWrapped` 的软换行
- 合并前验证上一行确实占到终端最右侧，避免 TUI 残留 `isWrapped` 扩大范围
- 使用 buffer cell width 把 JS 字符索引换成 xterm 坐标，覆盖 CJK、emoji、组合字符和宽字符占位 cell
- xterm range 是 1-based；结束位置不要多包含一个 cell
- HTTP(S) 和任何带 URI scheme 的文本不能被本地路径正则抢走
- 去掉英文和全角右括号、逗号、句号、分号等尾随标点，但不能无条件删除合法文件名字符
- 带空格路径只在边界明确时接受，例如有引号、括号或 `:line[:column]` 终点；不要吞掉后续自然语言
- 行列使用安全整数并设置合理上限，例如 `1..=10_000_000`

不要复制参考实现的「跨硬换行继续拼接」逻辑。显式换行不是终端视觉换行，猜测拼接容易把下一条命令或说明文字并入路径。

### 5.2 TerminalView 接入

在 `web/components/panes/TerminalView.tsx` 的 xterm 创建生命周期内：

1. 配置 OSC 8 `linkHandler`：file URI 进入本地路径弹窗；HTTP(S) 优先复用现有安全外链 service。若搜索后确认不存在，新增一个只包装 `openUrl` 的窄 service，不能从 `TerminalView` 直接调用 Tauri plugin；其他 scheme 无动作。
2. 非 SSH 终端注册本地路径 `ILinkProvider`。
3. `onActivate` 从 `currentSessionIdRef.current` 读取当前真实 session。为空或已关闭时 toast，不使用 React render 时的陈旧 `props.sessionId`。
4. `allowPosixAbsolute` 由宿主和运行时能力决定，不只看输出内容。
5. 把 provider 返回的 `IDisposable` 放进本次 xterm 初始化的清理集合。
6. effect cleanup 显式 dispose；随后维持现有 xterm、parser handler、renderer 和 listener 清理顺序。

更新 `TerminalView.test.tsx` 的 xterm mock，增加 `registerLinkProvider` 和可观察的 disposable。验证重新挂载不会重复注册，卸载会释放。

### 5.3 前端 service

建议新增：

- `web/services/terminalPathLinkService.ts`
- `web/services/terminalPathLinkService.test.ts`
- 从 `web/services/index.ts` 导出

建议契约：

```ts
export type TerminalPathKind = "file" | "directory";
export type TerminalPathDesktopAction = "openDefault" | "reveal";

export interface ResolvedTerminalPathLink {
  canonicalPath: string;
  kind: TerminalPathKind;
  runtimeKind: "local" | "wsl";
}

resolve(input: {
  sessionId: string;
  rawPath: string;
}): Promise<ResolvedTerminalPathLink>;

runDesktopAction(input: {
  sessionId: string;
  rawPath: string;
  action: TerminalPathDesktopAction;
}): Promise<void>;
```

`resolve` 使用当前项目的 `invokeOrApi`：桌面调用 Tauri command，Web 调用受现有认证中间件保护的 HTTP endpoint。`runDesktopAction` 仅在 Tauri runtime 调用 command；Web 分支返回 typed unsupported error，UI 正常情况下不会调用它。

不要从后端返回项目根，不把安全边界细节暴露给 renderer。错误使用项目现有 `AppError` code 和前端错误翻译机制，不靠字符串包含判断。

### 5.4 Dialog store

建议新增 `web/stores/useTerminalPathLinkStore.ts`，从 `web/stores/index.ts` 导出。

状态至少包含：

```ts
type TerminalPathLinkDialogState =
  | { phase: "closed" }
  | {
      phase: "resolving";
      requestId: number;
      sessionId: string;
      rawPath: string;
      line?: number;
      column?: number;
    }
  | {
      phase: "ready" | "acting";
      requestId: number;
      sessionId: string;
      rawPath: string;
      canonicalPath: string;
      kind: "file" | "directory";
      runtimeKind: "local" | "wsl";
      line?: number;
      column?: number;
      pendingAction?: "openEditor" | "openDefault" | "reveal" | "copy";
    };
```

动作要求：

- `open(reference, sessionId)` 先同步进入 `resolving`，再调用 service
- 每次 open 生成新 `requestId`
- resolve 成功或失败前比较 `requestId`；旧请求只被忽略
- `close()` 使当前请求失效
- 每个 action 只允许一次 in-flight
- resolve 与 action 都设置有界前端等待时间；超时恢复 UI，不允许按钮永久转圈
- store 负责状态转换，React 组件负责 toast 和调用具体动作，或抽出可独立测试的 action coordinator；不要把 React hook 用在模块级函数中

### 5.5 Radix Dialog

建议新增：

- `web/components/panes/TerminalPathLinkDialog.tsx`
- `web/components/panes/TerminalPathLinkDialog.test.tsx`

在 `web/components/layout/AppDialogs.tsx` 集中挂载。必须复用 `web/components/ui/dialog.tsx`，不要复制参考项目的手写 fixed overlay。

UI 约束：

- 最大宽度约 440px，`rounded-lg` 或更小，不做最大化
- 标题明确区分文件和目录
- 路径使用可选择、可换行的 monospace 区域；长路径不能撑出 Dialog
- 解析中显示 spinner，所有动作禁用
- 文件主按钮是「在编辑器中打开」，不是风险更高的系统默认程序
- 按钮使用 Lucide 图标；加载中使用 `Loader2`
- Radix 负责 focus trap、Escape、焦点恢复和 aria 语义
- 所有可见文案进入 `panes` 中英文 i18n JSON
- 失败保留 Dialog 供重试，resolve 本身失败则关闭并 toast
- 不显示实现说明、快捷键教程或安全策略文案

组件测试至少验证：

- resolving、file ready、directory ready、acting 四种状态
- Web 隐藏桌面动作
- Escape/关闭触发 store close
- 重复点击不会重复调用 action
- 长路径可见且完整保留在 DOM
- Dialog 有可访问名称，按钮名称来自 i18n

### 5.6 Monaco 行列定位

当前 `openEditor` 只能打开文件，不能传递一次性光标位置。新增一个非持久化的 reveal 通道，建议：

- `web/stores/useEditorRevealStore.ts`
- `web/stores/useEditorRevealStore.test.ts`

以规范 `filePath` 为 key，保存 `{ requestId, line, column }`。打开 Link 文件时：

1. 先写入 reveal request。
2. 调用 `usePanesStore.getState().openEditor(projectPath, canonicalPath, basename)`。
3. `EditorView` 在 Monaco 已挂载且 model 已加载后消费对应 request。
4. 用 model 的行数和 `getLineMaxColumn()` clamp 位置。
5. 调用 `setPosition`、`revealPositionInCenterIfOutsideViewport` 和 `focus`。
6. 消费后按 `requestId` acknowledge，避免旧 effect 清掉新请求。

同一文件已经打开时，新 request 也必须重新定位。没有行号时只打开文件，不抢光标。图片、二进制和目录不写 reveal request。Markdown 若处于纯预览模式，带位置打开时切回可见编辑器模式。

## 6. 后端实现要求

### 6.1 可信 session 上下文

不要让 resolver 接收 `projectPath`、`cwd` 或 `runtimeKind` 作为前端可信输入。

在 `cc-panes-core` 增加最小模型，例如：

```rust
pub struct TerminalLinkContext {
    pub project_path: String,
    pub runtime_kind: String,
}
```

给 `TerminalBackend` 增加 fail-closed 方法：

```rust
fn terminal_link_context(
    &self,
    session_id: &str,
) -> AppResult<Option<TerminalLinkContext>> {
    Ok(None)
}
```

实现要求：

- `TerminalSession` 保存创建时已经验证过的 `project_path` 和 `runtime_kind`
- `InProcessTerminalBackend` 从 `TerminalService` 查询 context
- `DaemonTerminalBackend` 从 daemon 的 `TerminalSessionProvenance` 推导 context
- provenance 缺失或 session 已退出时拒绝，不回退到前端路径
- `runtime_kind == "ssh"` 时 resolver 返回明确 unsupported error

不要伪造 daemon generation、birth nonce 或 provenance。link context 是独立的最小能力接口。

### 6.2 Core resolver

建议新增：

- `cc-panes-core/src/services/terminal_path_link_service.rs`
- 对应单元测试

解析顺序必须固定：

1. 拒绝空字符串、NUL、C0/DEL 控制字符、Unicode 双向覆盖/隔离控制符、超长输入和不支持的 URI scheme；Windows 额外拒绝 device namespace、drive-relative path 和 NTFS alternate data stream。
2. 取得 backend 提供的可信 context。
3. 拒绝 SSH。
4. 对可信项目根 `canonicalize()`。
5. raw path 是相对路径时 join 到项目根；是绝对路径时保留，但仍执行第 6 步。
6. `canonicalize()` 目标，解析 `..` 和符号链接。
7. 确认目标位于 canonical root 内；绝对路径也不能跳过 containment。
8. 读取 metadata，只接受普通文件或目录。
9. 完成边界判断后再使用项目现有 Windows 路径简化 helper 去掉 `\\?\` 前缀，不能在校验前改变语义。
10. 返回规范路径和类型。

不要对路径做 NFC/NFD/NFKC 等 Unicode 归一化。macOS 和 Linux 上不同 normalization form 可能对应不同目录项；授权逻辑应使用操作系统实际 canonicalize 的结果，而不是改写用户点击的文件名。

参考项目当前 `canonicalize_within_root` 对绝对路径直接 return，允许打开项目外任意现存文件。不要复制这个行为。以下内容必须拒绝：

- `C:\Windows\System32\drivers\etc\hosts`
- 项目内指向项目外的文件或目录 symlink
- `../../outside.md`
- 不存在目标
- socket、device、FIFO 等非普通文件/目录

所有文件系统工作放进 blocking 线程或同步 core service，由 async command/route 使用项目既有 `spawn_blocking` 模式，不能阻塞 Tauri async executor 或 Web runtime worker。

### 6.3 Tauri commands

建议新增 `src-tauri/src/commands/terminal_path_link_commands.rs`，从 `commands/mod.rs` 导出并在 `src-tauri/src/lib.rs` 注册：

- `resolve_terminal_path_link(session_id, raw_path)`
- `run_terminal_path_link_action(session_id, raw_path, action)`

`run_terminal_path_link_action` 只接受 enum action：

- `openDefault`：目标必须是文件
- `reveal`：文件在父目录中定位，目录直接打开

每次 action 重新查询 session context 并重新 canonicalize。使用 `tauri_plugin_opener::OpenerExt` 的 typed API或项目已有无 shell 的实现；禁止把 raw path 拼进 shell 字符串。不要调用当前会记录完整 path 的通用命令后再假装日志安全。

日志只记录 action、runtime、结果和不含原始路径的 session 短标识。错误响应不能用于探测项目根外文件是否存在：越界、缺失和不支持目标可使用稳定错误码，但不要回显未经授权的规范路径。

### 6.4 Web route

在 `cc-panes-web` 增加 resolver route，并复用当前认证、AppState 和 service error 映射：

- `POST /api/terminal/path-link/resolve`

请求只有 `sessionId` 和 `rawPath`。route 从 `AppState.terminal_backend` 获取 context，调用同一个 core resolver，不能在 Web 层复制一份路径授权逻辑。

Web 不提供系统默认程序和文件管理器 action endpoint。编辑器与复制动作在前端使用 resolve 返回值完成。

若 `cc-panes-api` 是当前路由契约的共享适配层，按现有模式同步契约；先搜索真实调用链，不要因为目录存在就机械增加未使用代码。

## 7. 安全硬约束

终端输出是不可信输入。以下条目任何一项未满足都不能交付：

- 授权根必须由活跃 session 的后端上下文产生
- absolute 和 relative path 都执行 canonical root containment
- canonicalize 后再做 containment，覆盖 `..` 与 symlink escape
- SSH fail closed，WSL POSIX absolute 不猜测映射
- 非 HTTP(S)/file scheme 不执行
- raw terminal text 从不进入 shell、URL opener 或系统命令
- 拒绝可造成视觉伪装的双向控制符、终端控制字符、Windows device path 和 ADS
- 默认程序和 reveal 在动作发生前重新授权
- parser 每行字符数、候选数和位置数值有上限
- 不在 hover 阶段做 IO
- 不记录完整路径或整段终端输出到生产日志
- 不新增 Tauri `opener` 权限；仓库已有 `opener:allow-open-path` 的 `**` scope，代码边界必须比 capability 更窄
- 不用前端隐藏按钮代替后端权限检查
- 不用字符串错误匹配代替 typed error
- 不新增依赖，现有 xterm、Radix、Lucide、Zustand 和 opener 足够

STRIDE 验收重点：

- Spoofing：伪造 sessionId 只能得到该真实 session 自己的 root，不能带入自定义 root
- Tampering：symlink 或文件替换后 action 会重新解析
- Repudiation：记录动作类型与结果，但不泄露完整路径
- Information disclosure：越界探测不返回目标存在性或规范路径
- Denial of service：解析窗口和候选数有界，无 hover IO，无无限缓存
- Elevation of privilege：项目外绝对路径、SSH 路径和未知 scheme 均拒绝

## 8. 测试矩阵

### 8.1 前端纯函数

至少覆盖 12 个有效和 12 个拒绝输入，包括：

- Windows `/` 与 `\` 分隔符
- POSIX absolute 开关
- `./`、`../`、普通项目相对路径
- `:line`、`:line:column`、0、负数、超上限
- 空格、中文、全角标点、右括号
- 同行多个路径
- HTTP(S)、file URI、unsupported scheme
- CJK、emoji、ZWJ emoji、组合字符前缀后的 xterm cell range
- bidi override、零宽控制符和终端控制字符拒绝
- 两行 soft wrap
- stale `isWrapped` 不跨行
- 硬换行不拼接
- 候选数和 2048 字符预算

### 8.2 Store 和 UI

- resolve 成功进入 ready
- resolve 失败关闭并 toast
- A 请求晚于 B 返回时不覆盖 B
- close 后迟到结果被忽略
- action 重入被阻止，超时后恢复
- session 在 resolve 期间关闭时 fail closed
- resolve 后关闭 Dialog，迟到的 action/resolve 不改变当前状态
- Web 断线、401/403、超时恢复为可重试状态
- file/directory/Web 动作集合正确
- copy 使用 canonical path
- Clipboard API 拒绝或不可用时显示错误且保留 Dialog
- Dialog focus、Escape、aria name 和长路径布局
- 纯键盘按 Tab/Shift+Tab/Enter 操作顺序正确，关闭后焦点回到来源终端

### 8.3 编辑器定位

- 新打开文件定位
- 已打开文件再次定位
- 行列越界 clamp
- 无行号不移动光标
- 旧 acknowledge 不清除新 request
- Markdown 位置请求能看到 Monaco 编辑区

### 8.4 Rust/core

- root 内相对文件、目录
- root 内绝对文件
- root 外绝对文件拒绝
- `../` 逃逸拒绝
- missing、NUL、超长、unsupported scheme
- 文件 symlink 和目录 symlink 逃逸
- session 不存在、已关闭、context 缺失
- session 在 resolve 与 action 之间关闭
- SSH 拒绝
- WSL 相对路径基于宿主 project root
- file/default action 类型不匹配
- action 重新解析
- resolve 后文件被删除、文件变目录、symlink 被替换时 action fail closed
- 权限拒绝和系统 opener 失败返回 typed error，不泄露 root 外信息

Windows symlink 测试如果 CI 无创建权限，不得直接跳过整个安全测试。把 containment 逻辑保持为平台无关单测；Windows 另补可运行的 canonical path/UNC root 用例，并在手工验证中覆盖 junction 或 WSL UNC。

### 8.5 回归

- `TerminalView` provider 只注册一次且销毁
- terminal selection/copy、右键菜单、IME、paste 测试继续通过
- xterm 不因 feature state 改变而重建
- editor tab 去重、Files 模式和 panes 模式保持原语义
- daemon 和 web route 使用同一个 core resolver

## 9. 实施顺序

按以下顺序做，每一步先补失败测试再写实现；无需等待人工逐步确认：

1. 前端纯 parser、soft-wrap range 与单测
2. core context 接口、resolver 与 Rust 单测
3. in-process/daemon context 接线
4. Tauri command、Web resolve route 与 service 测试
5. 前端 service、store 和竞态测试
6. Radix Dialog、i18n 和组件测试
7. Monaco reveal 通道和测试
8. TerminalView provider/OSC 8 接入和生命周期测试
9. 全量检查与手工桌面验证

不要在同一提交里顺手重构 TerminalView、filesystem service 或 Dialog 系统。新增抽象只服务于这条数据流。

## 10. 必跑验证

先跑聚焦测试，文件名以实际落地为准：

```powershell
npm run test:run -- web/lib/terminalPathLink.test.ts web/services/terminalPathLinkService.test.ts web/stores/useTerminalPathLinkStore.test.ts web/components/panes/TerminalPathLinkDialog.test.tsx web/components/panes/TerminalView.test.tsx web/components/editor/EditorView.test.tsx
cargo test -p cc-panes-core terminal_path_link
cargo test -p cc-panes terminal_path_link
cargo test -p cc-panes-web terminal_path_link
```

再跑仓库门禁：

```powershell
npx tsc --noEmit
npm run test:run
npm run build
cargo fmt --all -- --check
cargo check --workspace
cargo test --workspace
```

若 `cargo clippy --workspace -- -D warnings` 在当前机器可完成，也必须运行。任何失败都要区分：本次引入、既有失败、Windows-host-required；不能只贴最后一行。

桌面手工验证必须在 Windows host 的 Tauri dev app 中完成，不能用 jsdom 或纯 Web 结果代替：

1. 终端输出项目内真实文件绝对路径并点击。
2. 输出 `src/...:line:column` 并确认 Dialog 后 Monaco 定位。
3. 点击真实目录并验证动作集合。
4. 输出项目外绝对路径，确认拒绝。
5. 输出缺失路径，确认失败且终端仍可输入。
6. 拖选路径并复制，确认 Link 不破坏选择。
7. 重开/休眠唤醒终端，确认没有重复激活或 listener 泄漏。
8. WSL 项目验证相对路径；确认 `/home/...` 不被错误当作宿主路径。
9. SSH 终端确认不出现本地路径 Link。
10. Web 访问确认只显示编辑器和复制动作。
11. 断开 Web 网络或让 resolver 返回 401，确认 Dialog 不会永久 loading。
12. 让系统 opener 拒绝或目标在点击后被删除，确认错误可恢复且不执行旧目标。

## 11. 完成标准

只有同时满足以下条件才可以声称完成：

- 功能从 xterm 输出贯通到 Dialog、core 授权和最终动作
- 项目外 absolute、relative escape 和 symlink escape 均有绿色拒绝测试
- Local、WSL、SSH、Web 行为符合矩阵
- 行列定位对新文件和已打开文件都有效
- provider 生命周期测试证明无重复注册和泄漏
- 前端没有新增直接 `invoke()` 的 component/store 调用
- 没有新增依赖或扩大 Tauri capability
- 聚焦测试、TypeScript、build、fmt、workspace tests 有实际结果
- Windows 桌面行为由 Windows host 验证；未验证的项目明确标为未验证

## 12. 最终报告格式

完成后只报告：

1. 改动摘要，按 frontend/core/Tauri/Web 分组
2. 关键安全决策，特别是 session root、absolute containment、SSH/WSL 策略
3. 运行的命令及通过/失败数
4. Windows 手工验证结果
5. 未完成项或剩余风险
6. `git diff --stat` 和实际改动文件列表

不要用「应该可以」「理论上」替代验证结果，不要自动 commit 或 push。

[IMPLEMENTATION PROMPT END]

## 调研结论

### 参考实现中值得复用的部分

1. `src/lib/terminalPathLink.ts:28` 把 URI scheme 排除在本地路径正则之外，避免 HTTP 链接被路径 provider 抢占。
2. `src/lib/terminalPathLink.ts:144` 合并 xterm 软换行，并在后续版本加入「上一行确实占满最右 cell」检查，修复 TUI 残留 `isWrapped` 造成的跨行下划线。
3. `src/lib/terminalPathLink.ts:258` 按 cell width 映射 JS 字符索引，处理 CJK 宽字符。
4. `src/lib/terminalPathLink.ts:374` 使用 xterm `ILinkProvider`，没有改写终端输出文本，因而可保留选择和复制。
5. `src/store/terminalPathLinkStore.ts:88` 在弹窗前先解析目标类型，文件和目录提供不同动作。
6. `src-tauri/src/commands/file_ops.rs:56` 对相对路径先 canonicalize root，再 canonicalize target，能阻止 `..` 和 symlink 逃逸。

### 不能照搬的部分

1. 参考项目 `src-tauri/src/commands/file_ops.rs:49` 对 absolute path 直接 canonicalize 后返回，明确允许项目外文件。这与该 change 原始 success criteria 和本项目的安全边界冲突。
2. `src/store/terminalPathLinkStore.ts:75` 在 Zustand 模块中直接 `invoke`，不符合本项目「组件/Store -> Service -> IPC/API」约束。
3. `src/components/TerminalPathLinkModal.tsx:72` 手写遮罩、Escape 和点击外部关闭，没有复用当前项目已有的 Radix Dialog 焦点管理。
4. 参考项目直接调用 `@tauri-apps/plugin-opener`，系统动作没有在执行前按原始 session/path 重新授权。
5. 参考项目后续加入 hover existence probe；其 cache 实际主要去重 in-flight 请求，settle 后立即删除，不能提供注释所称的 5 分钟缓存，还会扩大 hover IPC 面。
6. 参考项目的硬换行路径拼接是启发式行为，可能把下一行命令或说明文字合并进 Link，不适合作为首版可靠默认值。
7. 参考项目没有覆盖当前仓库的 daemon provenance、Web API、WSL 和 SSH 路径语义。

## 安全评审摘要

| 风险 | 本提示词的处理 |
|---|---|
| 伪造项目根 | 前端不传 root，后端从 session context 获取 |
| `..`/symlink 逃逸 | root 与 target 都 canonicalize，再 containment |
| 项目外 absolute | 和 relative 使用同一 containment，默认拒绝 |
| SSH 远端路径误开本地文件 | 前后端双重 fail closed |
| 系统打开 TOCTOU | action 执行前重新解析原始 session/path |
| hover IPC/DoS | `provideLinks` 无 IO，解析窗口与候选数有界 |
| 命令注入 | typed opener API，不构造 shell 字符串 |
| 路径泄露 | 不记录 raw/canonical full path，不回显越界目标 |
| broad opener capability | 不扩大 capability；业务代码实施更窄授权 |

依赖审计环境说明：调研时 `npm audit` 因当前 `npmmirror.com` audit endpoint 返回 `NOT_IMPLEMENTED` 无法完成；本机未安装 `cargo-audit`。本功能不需要新增依赖，实施者仍需运行仓库已有测试与 lockfile 检查，并把依赖审计限制写入最终报告。
