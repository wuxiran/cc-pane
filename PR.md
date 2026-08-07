# 待 PR 文档（5 个功能）· 2026-08-05

> 当前分支：`dev_zhengjunkj`（基于 `origin/main` / `main` 最新 `0591742 chore: CODEOWNERS`）。
> 工作树暂存 41 修改文件 + 5 新文件，共 **46 项**。
> 目标：拆 5 个原子 commit → 5 个 PR，全部合到 `dev_zhengjunkj`（先合到 dev，不直接合 main）。

---

## 总览：5 个功能 + 提交顺序

| # | 类别 | Commit 标题（建议） | 风险等级 | 依赖 |
|---|------|-------------------|---------|------|
| 1 | provider | `feat(provider): 复制 Provider 走新建路径，模型行默认 1M 上下文窗口` | 低 | 无 |
| 2 | settings | `feat(settings): 终端设置新增 showStatusBar / showContextUsage 开关` | 中 | 无（独立 UI 开关，被 #3 使用） |
| 3 | terminal UI | `feat(terminal): 终端底部状态栏 + 上下文用量按终端独立` | 中 | #2 提供 settings 字段、#4 不依赖 |
| 4 | restore | `feat(restore): 异常退出旧 daemon 的冷恢复（点按钮结束旧终端并恢复）` | 高 | 无（独立模块） |
| 5 | cli-adapter | `feat(cli-adapter): Claude Provider 通过 --settings 文件注入环境变量` | 中 | 无 |

**建议顺序：2 → 3 → 1 → 4 → 5**
（理由：#2 先合给 #3 用 settings key；#1 独立且小放中间；#4 + #5 是新能力放最后，方便集中回归。）

---

## 1. `feat(provider): 复制 Provider 走新建路径，模型行默认 1M 上下文窗口`

**问题**：复制 Provider 走的是编辑路径，会调用 `updateProvider`，**覆盖原 provider**；新增模型行 `contextWindowTokens` 默认空，导致保存后 ContextUsageIndicator 一直显示「未知」。

**修复**：
- `ProviderFormPanel` 新增 `duplicateSeed` 入参。`duplicateSeed` 模式：保留被复制 provider 的字段作为 form 初值，但保存走 `addProvider`，不调用 `updateProvider`。
- `ProviderModelsEditor.addModel` 默认填 1,000,000 token（Claude / Gemini / GPT-4.1 主流模型默认 1M 上下文）。

**改动文件**：
- 修改：`web/components/providers/ProviderFormPanel.tsx`、`ProviderModelsEditor.tsx`、`ProvidersPanel.tsx`、`ProviderFormPanel.test.tsx`、`ProvidersPanel.test.tsx`

**测试**：
- `ProviderFormPanel` 新增「复制种子保存走 add 分支」用例
- `ProviderFormPanel` 新增「新增模型行默认 1M」用例

---

## 2. `feat(settings): 终端设置新增 showStatusBar / showContextUsage 开关`

**问题**：终端状态栏与上下文用量没有独立开关；用户想关闭后给终端区腾空间。

**修复**：
- `TerminalSettings` 加 `showContextUsage: bool` + `show_status_bar: bool`，老 config.toml 缺字段时回落 `true`（不能整段解析失败）。
- Settings 面板「终端」分组增加两个 checkbox，附带中英文案与 hint。
- Settings 注册表添加可搜索项。

**改动文件**：
- 修改：`cc-panes-core/src/models/settings.rs`（Rust 模型 + 默认值 + 解析兼容测试）、`web/types/settings.ts`、`web/stores/useSettingsStore.ts`、`useSettingsStore.test.ts`、`web/components/settings/TerminalSection.tsx`、`TerminalSection.test.tsx`、`settingsRegistry.ts`、`web/test/utils/testData.ts`、`web/i18n/locales/{en,zh-CN}/settings.json`

**测试**：
- Rust：`terminal_settings_without_show_status_bar_defaults_to_true` 旧 TOML 不含字段时回落 true
- TS：defaults 含两个新字段为 true

---

## 3. `feat(terminal): 终端底部状态栏 + 上下文用量按终端独立`

**问题**：
- 终端没有统一的状态栏（CLI 标签 / 模型 / effort / 上下文用量 / 项目路径都散落）。
- `ContextUsageIndicator` 用全局 `sessionId` 字段，多 pane 同时显示时会被互相覆盖。
- `useContextUsagePoller` 只跟随「当前激活终端」，非激活面板的 indicator 不刷新。

**修复**：
- 新增 `web/components/panes/TerminalStatusBar.tsx`：单终端底部状态条，承载状态点 / CLI / 模型 / effort / 上下文用量 / 项目路径；右键可关；全部关掉时整条不渲染（不留占位）。
- `TerminalTabContent` 接受 `showStatusBar` 开关；`Panel` 在「layout 同时含 ≥2 个 panel 且非全屏」时为每个 pane 渲染状态栏（避免单 pane 时白白挤掉终端高度）。
- `useContextUsageStore` 改成 `Map<sessionId, ContextUsageEntry>` 缓存每个 PTY 的快照；`setSession` 不再清掉别人的数据。
- `useContextUsagePoller` 接受外部 `terminalContext`（per-pane）；非激活面板也能轮询自己的用量。
- `ContextUsageIndicator` 接受外部 `terminalContext`，优先用 `sessions.get(sessionId).snapshot`，避免相互覆盖。
- Tooltip 重新设计：紧凑卡片样式，去掉「窗口来源：xxx」冗余字段，主数字着色。

**改动文件**：
- 新增：`web/components/panes/TerminalStatusBar.tsx`、`TerminalStatusBar.test.tsx`
- 修改：`web/components/panes/TerminalTabContent.tsx`、`TerminalTabContent.test.tsx`、`TabContentRenderer.tsx`、`TabContentRenderer.test.tsx`、`Panel.tsx`、`Panel.test.tsx`、`web/stores/useContextUsageStore.ts`、`useContextUsageStore.test.ts`、`web/hooks/useContextUsagePoller.ts`、`useContextUsagePoller.test.ts`、`web/components/ContextUsageIndicator.tsx`、`ContextUsageIndicator.test.tsx`、`web/components/StatusBar.tsx`、`web/i18n/locales/{en,zh-CN}/panes.json`

**测试**：
- `useContextUsageStore`：keeps independent snapshots for terminals shown at the same time
- `useContextUsagePoller`：polls an explicitly supplied grid terminal session
- `ContextUsageIndicator`：reads the snapshot for an explicitly supplied grid terminal
- `TerminalStatusBar`：开关、上下文用量渲染
- `Panel`：layout ≥2 panes 才启用状态栏
- `TabContentRenderer`：透传 `showTerminalStatusBar`

---

## 4. `feat(restore): 异常退出旧 daemon 的冷恢复（点按钮结束旧终端并恢复）`

**问题**：应用异常退出后，布局快照仍能恢复，但旧 daemon 不支持 `claims` 协议 → `claimsSupported=false`，当前前端把待恢复终端标 `claims-unsupported` 后只显示「会话恢复已阻断」和诊断日志，**没有任何继续恢复的操作**，用户只能删标签或重开。

**修复**（依据 `docs/81-abnormal-exit-session-recovery.md`）：
- `useTerminalSessionRestore.reconcileTerminalSessions` 改写：调用 `getDaemonClientInfo()` 区分 in-process / daemon 两种后端模式。
  - `in-process` + live：直接 `restoreLiveDaemonSessions` 重连，不阻断，不创建第二个 PTY。
  - `in-process` + 不在 live 列表：清掉 `restoreBlockedReason`，**静默允许冷恢复**（后台 TerminalView 会按原 `resumeId` 重建）。
  - daemon + `claimsSupported=false` + 旧 PTY 仍 live：保持阻断，但展示「结束旧终端并恢复」按钮。
  - daemon + `claimsSupported=false` + 旧 PTY 已退出：清掉 `restoreBlockedReason`，**静默允许冷恢复**。
- 新增 `coldRestoreBlockedTerminal(tabId, terminalPaneId)`：
  1. `beginTerminalColdRestore`：解绑 leaf 上的 `savedSessionId` 但保留 `restoreBlockedReason='claims-unsupported'`，置 `restoring=true`，**避免 daemon 的 kill 事件先把 leaf 关掉**。
  2. 调 `terminalService.killSession(previousSessionId)`。
  3. 成功后：`finishTerminalColdRestore(..., succeeded=true)` → 清阻断、递增 `launchAttempt`、`TerminalView` 按原配置 + `resumeId` 重建新 PTY。
  4. 失败：`finishTerminalColdRestore(..., succeeded=false)` → 还原 `savedSessionId`、保留阻断、**不**启动第二个 PTY。
- 新增 `usePanesStore.beginTerminalColdRestore` / `finishTerminalColdRestore` actions，封装到 `terminalColdRestoreActions.ts` 独立模块。
- `TerminalTabContent` 新增 `BlockedRestorePanel`：在 `restoreBlocked === 'claims-unsupported'` 且 `savedSessionId` 存在时显示「结束旧终端并恢复」按钮；点击触发 `coldRestoreBlockedTerminal`；失败时显示错误且不创建新 PTY。
- `terminalService.getAdoptionSnapshot` 修复：之前读快照会把 `cachedBackendClientInfo.mode` 强制写为 `'daemon'`，**覆掉了之前 `getDaemonClientInfo()` 探测到的 in-process 模式**。改成 `cachedBackendClientInfo?.mode ?? 'daemon'`。
- i18n 中英文案齐备：`coldRestoreTitle` / `coldRestoreHint` / `coldRestoreAction` / `coldRestoreRunning` / `coldRestoreFailed`，以及 `restoreBlocked.claims-unsupported` 文案补充。

**改动文件**：
- 新增：`docs/81-abnormal-exit-session-recovery.md`、`web/hooks/coldTerminalRestore.ts`、`web/stores/terminalColdRestoreActions.ts`
- 修改：`web/hooks/useTerminalSessionRestore.ts`、`useTerminalSessionRestore.test.ts`、`web/stores/panesStoreTypes.ts`、`usePanesStore.ts`、`usePanesStore.test.ts`、`web/components/panes/TerminalTabContent.tsx`、`TerminalTabContent.test.tsx`、`web/services/terminalService.ts`、`terminalService.test.ts`、`web/i18n/locales/{en,zh-CN}/panes.json`

**测试**：
- `reconcileTerminalSessions`：daemon 不支持 claim 但旧 PTY 已退出时允许冷恢复；进程内后端的活 PTY 直接重新挂回，不要求 kill
- `coldRestoreBlockedTerminal`：先 kill 旧 PTY 再提交新 PTY；kill 失败时回滚引用且不提交
- `usePanesStore` `legacy-daemon cold restore`：解除旧引用后可在成功时清除阻断，失败时完整回滚
- `terminalService`：读取快照后保留此前探测到的进程内 backend 模式

---

## 5. `feat(cli-adapter): Claude Provider 通过 --settings 文件注入环境变量`

**问题**：Managed Provider 的环境变量（API key / base URL / model）原本只在进程环境里传给 Claude CLI。Claude CLI 在进程创建后会读取 user-scoped settings.json，user-level 的 `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / 模型选择会**覆盖**我们注入的 Managed 值，导致 user 配置的第三方 Provider 被悄悄切换回 Anthropic 直连。

**修复**：
- `ClaudeAdapter` 新增 `generate_provider_settings`：
  - 从 `adapter_options[MAMAGED_PROVIDER_ENV_OPTION]` 取 Managed env JSON；
  - 把所有 routing 相关 env key（`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` / `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` / AWS 系列）**显式 reset**（缺失则补空串），确保 user-level 设置无法覆盖；
  - 把 model id 写入 `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL` / `ANTHROPIC_DEFAULT_OPUS_MODEL` / `CLAUDE_CODE_SUBAGENT_MODEL` 五个 key；
  - 原子写入 `<data_dir>/claude-provider-<sessionId>.json`（`{"env": {...}}`）；
  - 调用前 `cleanup_stale_provider_settings` 清理 >1 小时的同前缀旧文件，避免上次崩溃残留。
- `build_command` 在 `--dangerously-skip-permissions` 之前追加 `--settings <path>`，让 CLI 用 settings 文件覆盖 user-level env。
- `cc-cli-adapters/src/lib.rs` 新增常量 `MANAGED_PROVIDER_ENV_OPTION = "__ccpanesProviderEnv"`（internal 通道，含 credentials，永不日志、永不进 CLI args）。
- `terminal_service.rs` 在 `cli_tool == Claude && provider_plan.mode == ProviderMode::Managed` 时把 provider env JSON 注入 `adapter_options[MANAGED_PROVIDER_ENV_OPTION]`。
- `provider_resolver.rs::managed_provider_conflict_env_keys` 加上 5 个 model env key，让冲突检测包含 model 字段。

**改动文件**：
- 修改：`cc-cli-adapters/src/claude.rs`（+ 测试）、`cc-cli-adapters/src/lib.rs`、`cc-panes-core/src/services/terminal_service.rs`、`cc-panes-core/src/services/provider_resolver.rs`（+ 测试）、`cc-panes-core/src/models/settings.rs`

**测试**：
- `ClaudeAdapter`：build_command_overrides_user_routing_with_managed_provider_settings —— 检查生成的 settings.json 含 base URL / model / subagent_model，且 `ANTHROPIC_AUTH_TOKEN` 被清空；确认 args 里没有泄露 provider secret。
- `provider_resolver::managed_conflict_lists_are_cli_scoped_and_never_apply_to_shell`：确认 `ANTHROPIC_MODEL` / `CLAUDE_CODE_SUBAGENT_MODEL` 加入冲突列表。

---

## 跨 PR 注意点（请评审时确认）

1. **顺序**：建议合 PR 顺序 = 2 → 3 → 1 → 4 → 5；#3 依赖 #2 的 settings key，#4 / #5 与 #2/#3 几乎无重叠。如果想合并 PR 数，可以把 #2 + #3 合一（它们都围绕「终端底部状态栏配置/展示」）。
2. **#4 高风险**：涉及「杀掉用户旧 PTY」的破坏性恢复路径。需要在合并前**手动按 docs/81 第 5 节验收标准**实测：
   - 异常结束应用、保留旧 daemon、重新打开、点击恢复；
   - 确认旧 PID 退出且**仅出现一个新**的 resume 进程；
   - 杀掉旧 daemon 时不应误启动第二个进程。
3. **#5 兼容性**：新生成的 `<data_dir>/claude-provider-<sessionId>.json` 与 Claude Code 的 settings.json schema 对齐。如果用户开了 `--settings` 自定义路径，CLI 仍以我们传的文件优先，行为不冲突；不过需要确认 Claude CLI 真的把 settings 文件里的 `env` 视为「覆盖 user-level」而非「仅补缺」。
4. **文案**：所有新增 / 修改文案都已加 i18n key；中英文齐备，没有 fallback。
5. **回归**：每组都有聚焦测试。最终状态建议跑 `npm run test:run` + `cargo check --workspace` + `cargo clippy --workspace -- -D warnings` + `cargo test --workspace`，按仓库的 `npm run finish-work` 流程。

---

## 我接下来的执行步骤（待你 OK 后再动）

1. 在 `dev_zhengjunkj` 上基于 `origin/main` 拉一个新分支（暂定 `pr/2026-08-05-5-features`），worktree 干净开局。
2. 把工作树 46 项改动按上面 5 组拆开：用 `git reset` + `git stash` 按文件分组，**每组**：
   - `git add` 该组文件
   - `git commit -m "<上面写好的标题>"`，按 2 → 3 → 1 → 4 → 5 顺序
   - 跑该组对应的测试（vitest 按文件 / cargo test -p <crate>）
3. 5 个 commit 完成后：`git push origin dev_zhengjunkj`（用 gitee SSH，`TortoiseGitPlink.exe` + `gitee.ppk`），然后 `gh pr create` 5 个 PR，全部 target `dev_zhengjunkj`（先合到 dev，不直接合 main）。
4. 把 PR 链接回填到这里。

---

**请确认两件事再动手**：
- (A) 分组 / 顺序是否 OK？特别是要不要把 #2 + #3 合并成一个 PR？
- (B) target 分支我先按你说的合到 `dev_zhengjunkj`，对吗？