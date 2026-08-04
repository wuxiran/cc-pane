# 76 · 活跃会话上下文使用量：参考实现与一轮 AI 实现提示词

> 目标：在 CC-Panes 底部状态栏显示当前活动终端的上下文占用，交互与口径参考
> `F:\C26\gitee.com\zhengjunkj\ccpanel`，但实现必须落在 CC-Panes 现有的 core / Tauri / Web / React 分层中。
>
> 本文不是完成情况声明，而是可以直接交给高级 AI 执行的实现说明。

## 结论

这个功能不应从 xterm 输出中匹配文字，也不应把历史累计 token 当作当前上下文。正确链路是：

```text
当前活动 terminal leaf
  -> PTY session id
  -> launch_history 精确解析 CLI / resume id / runtime
  -> 对应 Claude 或 Codex JSONL 的最后一条有效用量
  -> 统一 ContextUsageSnapshot
  -> 10 秒轮询 + 25 秒 stale 缓存
  -> StatusBar 固定宽度进度条与 hover 详情
```

首版支持 Claude Code 与 Codex 的 local / WSL 会话。纯 shell、其他 CLI 和 SSH 会话不显示该段；不能读取数据时显示未知态，绝不能伪造 `0%`。Web 端走相同 HTTP 适配层，由服务器读取服务器所在环境的会话文件。

## 参考实现里真正值得复用的部分

CCPanel 当前实现已经把采集、状态和显示拆开，不是一个孤立的进度条：

| 参考文件 | 可借鉴内容 |
|---|---|
| `src-tauri/src/commands/context_usage.rs:134` | `ContextUsageSnapshot` 统一契约，以及 ready / waiting / stale / error 语义 |
| `src-tauri/src/commands/context_usage.rs:229` | Codex 原始窗口扣除 12k baseline 后计算有效占用 |
| `src-tauri/src/commands/codex_usage.rs:331` | 从 `token_count.payload.info.last_token_usage` 读取当前上下文，不累计整场会话 |
| `src-tauri/src/commands/conversation.rs:550` | Claude 当前上下文为 input + cache read + cache creation，不含 output |
| `src/hooks/useContextUsagePoller.ts:10` | 每 10 秒一次、禁止请求重入的轮询策略 |
| `src/store/contextUsageStore.ts:11` | 25 秒后转 stale，瞬时读取失败时保留最后一次有效值 |
| `src/components/ContextUsageIndicator.tsx:120` | 固定宽度进度条、百分比、token 缩写、hover 详情与异常态 |
| `src/components/TerminalStatusBar.tsx:313` | 指示器与当前终端绑定，而不是显示一个全局累计值 |

截图中的 Codex 示例之所以是 `37% · 139k / 353k`，是因为百分比按有效口径计算：

```text
raw used       = 139k
raw window     = 353k
baseline       = 12k
effective used = 127k
effective win  = 341k
used percent   = round(127 / 341 * 100) = 37%
```

状态栏保留 raw token，hover 再显示有效口径，用户既能对上 JSONL 原值，也能对上 Codex TUI 的百分比。

## CC-Panes 的落点

CC-Panes 已经有本功能所需的大部分基础设施：

- [StatusBar.tsx](../web/components/StatusBar.tsx) 是 28px 高的应用底栏，左侧已有工作区和活动终端数，新的会话上下文段放在活动终端数之后。
- [useFollowActiveTerminalContext.ts](../web/hooks/useFollowActiveTerminalContext.ts) 已按 `activePaneId -> activeTabId` 找当前 tab；新 selector 还要继续解析 `activeTerminalPaneId` 对应的 leaf，并兼容尚无 terminal tree 的旧 tab 数据。
- [terminal.ts](../web/types/terminal.ts) 的 leaf 已有 `sessionId`、`resumeId`、`cliTool`、`wsl`、`ssh`，不需要再造一套终端身份。
- [history_repo.rs](../cc-panes-core/src/repository/history_repo.rs) 的 `LaunchRecord` 已保存 PTY session、resume session、CLI、runtime 与 WSL distro。
- [launch_history_service.rs](../cc-panes-core/src/services/launch_history_service.rs) 已支持按 PTY session 精确查启动记录。
- [usage_stats_service.rs](../cc-panes-core/src/services/usage_stats_service.rs) 已扫描 local / WSL 的 Claude、Codex JSONL，并已有 WSL 冷启动门控。
- [claude_session_service.rs](../cc-panes-core/src/services/claude_session_service.rs) 与 [codex_session_service.rs](../cc-panes-core/src/services/codex_session_service.rs) 已有用量 JSONL 解析器；应扩展“最后一次上下文观测”，不要复制一套不一致的 token 字段解析。
- [sessionIndexService.ts](../web/services/sessionIndexService.ts) 展示了 `invokeOrApi` 的桌面 / Web 双适配方式。

推荐把共享快照模型和解析逻辑放在 `cc-panes-core`，由现有 `UsageStatsService` 暴露按 PTY session 查询当前上下文的方法。这样可复用它持有的 `LaunchHistoryService`、settings 与 WSL 运行缓存，也避免给 `cc-panes-web::AppState` 再增加一个会波及大量测试构造器的新 service 字段。

```text
React StatusBar
  -> contextUsageService.get(ptySessionId)
  -> invokeOrApi
      -> Tauri command
      -> Axum GET /api/context-usage/:ptySessionId
  -> UsageStatsService::context_usage_for_pty
  -> LaunchHistoryService::find_by_pty_session_id
  -> Claude/Codex latest observation parser
```

## UI 与文案

### 状态栏

正常态固定为一行，不改变底栏高度：

```text
[■■□□□□] 37% · 139k
```

- 进度条固定 `40px x 6px`，数字使用等宽字体与 tabular nums。
- `< 50%` 使用 `--app-status-success`，`50% - 89%` 使用 `--app-status-warning`，`>= 90%` 使用 `--app-status-danger`。
- 窄窗口只显示 14px 圆环；hover 内容不缩减。
- 没有活动终端、活动 tab 不是 terminal、CLI 不支持或是 SSH 时不渲染。
- 等待第一条有效 usage 时显示 `-%`，不能显示 `0%`；真实的零用量仍显示 `0% · 0`。
- stale 状态保留最后数值并加时钟图标；error 状态显示警告图标与 `-%`。

### Hover 详情

```text
上下文使用量
37% · 139k / 353k
有效口径：127k / 341k
gpt-5.6-sol
```

只有 raw 与 effective 不同时才显示“有效口径”。诊断码、文件路径、session id 不默认暴露在 UI；开发日志可以记录不含 prompt / API key 的诊断信息。

建议 i18n 文案：

| key | zh-CN | en |
|---|---|---|
| `contextUsage.title` | 上下文使用量 | Context usage |
| `contextUsage.effective` | 有效口径 | Effective |
| `contextUsage.waiting` | 等待首条用量数据 | Waiting for usage data |
| `contextUsage.stale` | 数据已 {seconds} 秒未更新 | Data is {seconds}s old |
| `contextUsage.error` | 暂时无法读取上下文用量 | Context usage is unavailable |

## 数据契约与计算口径

前后端统一 camelCase，所有未知字段显式传 `null`，不要靠字段缺失表达状态：

```ts
type ContextUsageStatus = "ready" | "waiting" | "stale" | "error";

interface ContextUsageSnapshot {
  status: ContextUsageStatus;
  usedTokens: number | null;
  effectiveUsedTokens: number | null;
  windowTokens: number | null;
  effectiveWindowTokens: number | null;
  usedPercentage: number | null;
  remainingPercentage: number | null;
  model: string | null;
  usageSource: string | null;
  windowSource: string | null;
  agentSessionId: string | null;
  parserVersion: string | null;
  observedAt: number;
  diagnosticCode: string | null;
}
```

诊断码至少覆盖：

```text
WAITING_FIRST_RESPONSE
SESSION_NOT_FOUND
SOURCE_UNAVAILABLE
USAGE_INVALID
WINDOW_UNKNOWN
SCHEMA_CHANGED
RUNTIME_UNSUPPORTED
AMBIGUOUS_SESSION
```

### Claude Code

读取当前会话 JSONL 最后一条有效 assistant usage：

```text
usedTokens = input_tokens
           + cache_read_input_tokens
           + cache_creation_input_tokens
```

`output_tokens` 是生成量，不属于下一轮可见的活动上下文，不加入占用。窗口优先使用上游明确提供的值；否则按当前模型能力表解析；仍无法解析时首版可用 Claude 200k 默认值，但必须把 `windowSource` 标为 `claude-default:200k`，不能伪装成上游精确值。

### Codex

读取最新 `token_count` 事件中的：

```text
payload.info.last_token_usage.total_tokens
payload.info.model_context_window
```

兼容旧记录时，只有同时存在 input / output 才允许用两者之和回退。模型从最近的 `turn_context` 或 `session_meta` 获取。百分比按 Codex 的 12k baseline 计算：

```text
effectiveUsed   = max(rawUsed - 12_000, 0)
effectiveWindow = rawWindow - 12_000
usedPercentage  = round(effectiveUsed / effectiveWindow * 100)
```

窗口不大于 12k、负 token、溢出、字段类型改变都返回明确诊断，不 panic，也不回退成零。

## 身份、缓存与运行环境

### 会话身份

后端只接收 PTY session id，并用 `launch_history` 解析其余身份。优先用 `resume_session_id` 精确定位 JSONL；缺少 resume id 时保持 waiting。只有候选在 CLI、cwd、启动时间上唯一时才可回退，多个相同目录并行会话禁止用“最新文件”猜测，否则状态栏会显示另一个终端的 token。PTY / resume id 必须限制长度与字符集，解析出的 JSONL canonical path 必须位于对应 CLI session root 内。

### 增量读取

- 每个 agent session 缓存 `file_path + byte_offset + last observation + file identity`。
- 文件增长时从上次完整换行处继续；文件截断、替换或路径变化时重置。
- 同一 PTY 同时最多一个读取请求；StatusBar 挂载与活动 leaf 切换时立即读取，之后每 10 秒读取。
- 首次读取必须有边界。参考上限可采用 Codex 4 MiB / 20,000 行 / 单行 1 MiB，Claude 32 MiB / 100,000 行；超限返回诊断，不能无限读盘。
- 25 秒没有新鲜成功值时把最后有效快照标 stale；瞬时错误到达 stale 阈值前保留 ready 数值。
- 不把这份实时快照写入 SQLite。历史统计继续归 `UsageStatsService` 现有聚合表管理。

### 环境矩阵

| 环境 | 首版行为 |
|---|---|
| Local Windows / macOS / Linux | 支持，读取当前用户的 Claude / Codex 会话目录 |
| WSL on Windows | 支持，但必须复用 `disableWslUsageScan` 与“VM 已运行”门控；不得因轮询访问 `\\wsl$` 而冷唤醒 WSL |
| SSH | 首版不支持，不执行远程命令，不在状态栏显示该段 |
| Web 客户端 | 通过 HTTP 调用服务器端相同 service；不尝试从浏览器读取本地文件 |

## 本次不做

- 不做自动 `/compact`、阈值通知或设置项。
- 不做费用统计、历史趋势或把现有 Home Usage Stats 搬到状态栏。
- 不解析 xterm 文本，不修改 Claude/Codex 自带 statusline，不覆盖用户配置。
- 不为 Gemini、Kimi、GLM、Grok、Cursor、OpenCode 猜 token 口径。
- 不因为实现实时用量而改变现有 5 分钟历史 usage scan 周期。

## 验收标准

1. 活动 Codex 会话的 fixture 为 raw `139k / 353k` 时，状态栏显示 `37% · 139k`，hover 显示 `有效口径：127k / 341k`。
2. 切换 pane、tab 或 terminal split 后，10 秒内只显示新活动 leaf 的数据；旧请求晚返回也不能覆盖新会话。
3. 两个相同 cwd 的并行会话不会互相串数据。
4. waiting 显示 `-%`，真实零值显示 `0%`，二者有测试区分。
5. 一次瞬时读取失败不清空最后有效值；25 秒后显示 stale 与数据年龄。
6. 停止的 WSL 不会被轮询唤醒；关闭 WSL usage scan 后不访问 UNC 根。
7. Tauri 与 Web 返回同一 JSON 契约；纯 shell、SSH 与不支持 CLI 不发轮询。
8. 状态栏维持 28px 高，进度条和文字不挤压右侧系统资源与窗口工具；窄窗口退化成圆环。
9. 新增中英文 i18n，不引入 raw text 基线债务。
10. TypeScript、Vitest、Rust fmt/check/clippy/test 通过；Windows 宿主完成一次真实 Claude 与 Codex UI 验证。

## 一轮 AI 实现提示词

下面整段一次性发给高级 AI：

```text
你正在 F:\C26\demo\cc-pane 实现“当前活动终端的上下文使用量”。请直接完成代码、测试和验证，不要只给方案，不要等待我逐步确认，也不要提交 git commit。

开始前完整阅读仓库 AGENTS.md，并阅读 docs/76-context-usage-indicator.md。参考实现位于 F:\C26\gitee.com\zhengjunkj\ccpanel，重点阅读这些文件，不要整文件照搬：
- src-tauri/src/commands/context_usage.rs
- src-tauri/src/commands/codex_usage.rs
- src-tauri/src/commands/conversation.rs
- src/store/contextUsageStore.ts
- src/hooks/useContextUsagePoller.ts
- src/components/ContextUsageIndicator.tsx
- src/components/TerminalStatusBar.tsx

先检查当前 git status，保留所有用户已有改动。实现范围严格按 docs/76-context-usage-indicator.md：只做 Claude Code + Codex 的实时上下文用量，支持 local 与已运行的 WSL，提供 Tauri + Web 双通道，在全局 StatusBar 显示当前 active terminal leaf；不做自动 compact、通知、历史费用、不支持 SSH 和其他 CLI。

实现时遵守以下硬要求：

1. 身份必须正确。前端从当前 live `rootPane` 按 `activePaneId -> panel.activeTabId -> tab.activeTerminalPaneId -> TerminalPaneLeaf` 取得 PTY `sessionId`；对尚无 terminal tree 的旧持久化 tab，兼容回退到 tab.sessionId，但不能跨 tab 猜测。后端只信 PTY session id，并通过 `LaunchHistoryService::find_by_pty_session_id` 得到 resume session id、cli_tool、runtime_kind 和 wsl_distro。缺 resume id 时 waiting；同 cwd 并发时禁止用“最新 JSONL”猜会话。校验 PTY / resume id 的长度与字符集，canonical JSONL path 必须仍位于允许的 Claude/Codex session root 下。

2. 在 cc-panes-core 定义序列化为 camelCase 的统一 `ContextUsageSnapshot`。unknown 字段显式为 null，状态至少有 ready/waiting/stale/error，诊断码覆盖 WAITING_FIRST_RESPONSE、SESSION_NOT_FOUND、SOURCE_UNAVAILABLE、USAGE_INVALID、WINDOW_UNKNOWN、SCHEMA_CHANGED、RUNTIME_UNSUPPORTED、AMBIGUOUS_SESSION。后端的正常不可用状态应作为快照返回，不要让前端靠 rejected promise 猜语义。

3. 优先扩展现有 `UsageStatsService`，新增按 PTY session 查询实时上下文的方法，复用其 launch history、settings、WSL 运行缓存与已有 JSONL 根目录策略。扩展 `claude_session_service.rs` / `codex_session_service.rs` 的字段解析或抽出小模块，不要用历史累计 `UsageEntry` 直接算当前上下文，也不要建立第二套全盘后台扫描器。保持文件 <800 行、函数 <50 行；必要时拆 `services/context_usage/` 子模块。

4. Claude 读取最后一条有效 assistant usage，used = input + cache_read + cache_creation，不含 output。窗口优先用上游明确值或已存在的模型配置能力；无法解析时可用 200k fallback，但 `windowSource` 必须明确为 `claude-default:200k`。Codex 读取最新 `token_count.payload.info.last_token_usage.total_tokens` 与 `model_context_window`，模型从最近 turn_context/session_meta 获取；百分比按 12,000 baseline 扣减后的 effective used/window 计算，UI 主数字仍显示 raw token。所有数值检查负数、溢出和 schema 类型。

5. 读取必须增量、有界、可取消语义清晰：缓存 file path、完整行 byte offset 与 last observation；文件截断/替换时重置；禁止重叠请求；首次扫描设置字节、行数、单行大小上限。每 10 秒轮询，活动 leaf 切换时立即轮询；用 cycle/request generation 防止旧请求覆盖新会话。25 秒无新鲜成功值后显示 stale，短暂失败期间保留 last-ready。

6. WSL 必须尊重 `general.disableWslUsageScan` 和已有 VM-running gate。停止的 WSL 不得因为访问 `\\wsl$` 或调用 discovery 被唤醒。SSH、纯 shell和非 Claude/Codex 直接不轮询、不显示。Web 端新增 Axum route 并复用同一个 core service，前端按现有 `invokeOrApi` 模式封装；Tauri command 在 commands/mod.rs 与 lib.rs 注册。

7. UI 新建聚焦的小组件与 store/hook，不把解析逻辑塞进 `StatusBar.tsx`。组件放在底栏左侧活动终端数之后，保持 28px 高：固定 40x6 进度条 + `37% · 139k`，hover 显示 raw used/window、仅在不同时显示 effective used/window、模型、stale/error 文案。颜色只用现有 `--app-status-success|warning|danger` 等 token：<50 绿、50-89 黄、>=90 红。窄窗口显示 14px 圆环，使用 lucide Gauge/Clock3/AlertTriangle 和现有 Tooltip。waiting 显示 `-%`，真实 0 显示 `0%`。补 zh-CN/en i18n，不新增 raw text 基线债务。

8. 添加测试：Claude/Codex 当前用量 fixture、Codex total_tokens 和 legacy fallback、12k baseline、malformed/negative/overflow/partial line/truncation、PTY 到 resume 精确绑定、相同 cwd 不串会话、WSL disabled/no-cold-wake、Rust/TS camelCase 契约；前端测试 active leaf selector、轮询重入与旧请求、last-ready/stale、waiting 与真实零、颜色阈值、raw/effective hover、窄屏圆环、unsupported 隐藏。尽量复用现有 test helpers。

9. 验证至少运行：npx tsc --noEmit、相关 Vitest 后再跑 npm run test:run、cargo fmt --all -- --check、相关 crate 测试、cargo check --workspace、cargo clippy --workspace -- -D warnings。若全量命令受环境或既有失败阻塞，给出准确命令、错误与是否由本次改动引起。Windows 桌面真实行为只能标为 Windows-host-required，不能用普通单测冒充验证。

完成后自查 git diff，只汇报本次改动文件、数据口径、测试证据和仍需 Windows 宿主验证的项目。不要顺手重构无关模块，不要覆盖用户改动，不要提交或推送。
```
