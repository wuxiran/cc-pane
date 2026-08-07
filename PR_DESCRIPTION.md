# PR · 2026-08-05 · 5 个新功能

## 标题

```
feat: 5 个新功能（终端底部状态栏 / Provider 复制 / 上下文用量按终端独立 / 异常退出冷恢复 / Claude Provider 注入）
```

或者如果你想拆 5 个独立 PR，每个用以下标题（base 都是 `dev_zhengjunkj`，每个 PR 自己挑一个 commit 的 hash 当 head ref）：

```
feat(provider): 复制 Provider 走新建路径，模型行默认 1M 上下文窗口
feat(settings): 终端设置新增 showStatusBar / showContextUsage 开关
feat(terminal): 终端底部状态栏 + 上下文用量按终端独立
feat(restore): 异常退出旧 daemon 的冷恢复（点按钮结束旧终端并恢复）
feat(cli-adapter): Claude Provider 通过 --settings 文件注入环境变量
```

---

## PR 描述（body）

```markdown
## 概述

本次合并 **5 个新功能 + 6 个先前累积在 dev_zhengjunkj 上的 commit**，共 11 个 commit。
本 PR 描述只展开 5 个新功能；6 个历史累积 commit 见下方「历史 commit 清单」段。

5 个新 commit 顺序已按依赖关系组织（#2 → #3 → #1 → #4 → #5）。
`feat(restore)` 与 `feat(cli-adapter)` 是两个新能力，其余 3 个是 UI / settings / Provider 模型行的体验修复。

| # | Commit | 类别 | 风险 |
|---|--------|------|------|
| 1 | feat(provider) | 体验修复 | 低 |
| 2 | feat(settings) | 体验 | 中 |
| 3 | feat(terminal) | 体验 | 中 |
| 4 | feat(restore) | 新能力 | **高** |
| 5 | feat(cli-adapter) | 新能力 | 中 |

**合并顺序建议**：按 commit 时间线顺序合；#3 依赖 #2 的 settings 字段，#4/#5 独立。
**回归建议**：合并前跑 `cargo test --workspace` + `npm run test:run` + `cargo clippy --workspace -- -D warnings`。

---

## 改动细节

### #1 `feat(provider): 复制 Provider 走新建路径，模型行默认 1M 上下文窗口`

- `ProviderFormPanel` 新增 `duplicateSeed` 入参：保留被复制 provider 的字段作为 form 初值，但保存走 `addProvider` 分支，不再误调 `updateProvider` 覆盖原 provider。
- `ProvidersPanel` 改用 `duplicateSeed` state，复制按钮不再 `setEditingProvider`。
- `ProviderModelsEditor.addModel` 默认填 1,000,000 token，避免保存后 ContextUsageIndicator 显示「未知」。

**测试**：`ProviderFormPanel` 新增「复制种子保存走 add 分支」与「新增模型行默认 1M」两条用例。

### #2 `feat(settings): 终端设置新增 showStatusBar / showContextUsage 开关`

- `TerminalSettings` 加 `show_context_usage` / `show_status_bar`，老 `config.toml` 缺字段时回落 `true`，不能整段解析失败。
- 前端 `settings.ts`、`useSettingsStore`、`testData` defaults 同步。
- `TerminalSection` 加两个 checkbox + 中英文案 hint。
- `settingsRegistry` 注册可搜索项。

**测试**：Rust `terminal_settings_without_show_status_bar_defaults_to_true`、前端 defaults 测试。

### #3 `feat(terminal): 终端底部状态栏 + 上下文用量按终端独立`

- 新增 `TerminalStatusBar`：单终端底部状态条，承载状态点 / CLI / 模型 / effort / 上下文用量 / 项目路径；右键可关；全部关掉时整条不渲染。
- `TerminalTabContent` 接受 `showStatusBar` 开关；`Panel` 在 layout 同时含 ≥2 个 panel 且非全屏时为每个 pane 渲染状态栏（避免单 pane 时挤掉高度）。
- `useContextUsageStore` 改 `Map<sessionId, ContextUsageEntry>` 缓存每 PTY 快照；`setSession` 不再清掉别人的数据。
- `useContextUsagePoller` 接受外部 `terminalContext`，非激活面板也能轮询自己的用量。
- `ContextUsageIndicator` 接受外部 `terminalContext` + 紧凑 tooltip（去掉冗余「窗口来源」字段）。
- `StatusBar` 用 `showContextUsage` 控制全局指示器。

**测试**：`useContextUsageStore` keeps independent snapshots、`useContextUsagePoller` polls an explicitly supplied grid terminal、`ContextUsageIndicator` reads the snapshot for an explicitly supplied grid terminal；TerminalStatusBar / Panel / TabContentRenderer / TerminalTabContent 状态栏透传。

### #4 `feat(restore): 异常退出旧 daemon 的冷恢复（点按钮结束旧终端并恢复）` ⚠️ 高风险

**问题**：应用异常退出后，布局快照仍能恢复，但旧 daemon 不支持 claims 协议 → `claimsSupported=false`，前端把待恢复终端标 `'claims-unsupported'` 后只显示阻断文案，没有继续恢复的操作，用户只能删标签或重开。

**修复**（依据 `docs/81-abnormal-exit-session-recovery.md`）：

- `useTerminalSessionRestore.reconcileTerminalSessions` 改写：调用 `getDaemonClientInfo()` 区分 in-process / daemon 两种后端模式。
  - **in-process + live**：直接 `restoreLiveDaemonSessions` 重连，不阻断，不创建第二个 PTY。
  - **in-process + 不在 live**：清掉 `restoreBlockedReason`，**静默允许冷恢复**。
  - **daemon + `claimsSupported=false` + 旧 PTY 已退出**：清掉阻断，**静默允许冷恢复**。
  - **daemon + `claimsSupported=false` + 旧 PTY 仍 live**：保留阻断 + 新增「结束旧终端并恢复」按钮入口。
- 新增 `coldRestoreBlockedTerminal(tabId, terminalPaneId)`：
  1. `beginTerminalColdRestore`：解绑 leaf 的 `savedSessionId` 但保留 `restoreBlockedReason`，避免 daemon 的 kill 事件先把 leaf 关掉。
  2. `killSession(previousSessionId)`。
  3. 成功 → `finishTerminalColdRestore(succeeded=true)` 清阻断、递增 `launchAttempt`、TerminalView 按原配置 + `resumeId` 重建新 PTY。
  4. 失败 → `finishTerminalColdRestore(succeeded=false)` 还原引用、保留阻断、**不**启动第二个 PTY。
- 新增 `usePanesStore.beginTerminalColdRestore` / `finishTerminalColdRestore` actions，封装到 `terminalColdRestoreActions.ts` 独立模块。
- `TerminalTabContent` 新增 `BlockedRestorePanel`：仅在 `claims-unsupported` 且 `savedSessionId` 存在时显示按钮；点击触发冷恢复；失败时显示错误且不创建新 PTY。
- `terminalService.getAdoptionSnapshot` 修复：原代码会把 `cachedBackendClientInfo.mode` 强制写为 `'daemon'`，**覆掉之前 `getDaemonClientInfo()` 探测到的 in-process 模式**。改为 `cachedBackendClientInfo?.mode ?? 'daemon'`。
- i18n 中英文案齐备：`coldRestoreTitle` / `coldRestoreHint` / `coldRestoreAction` / `coldRestoreRunning` / `coldRestoreFailed`；`restoreBlocked.claims-unsupported` 文案补充「可结束旧终端后手动恢复」。

**测试**：
- `reconcileTerminalSessions`：daemon 不支持 claim 但旧 PTY 已退出时允许冷恢复；进程内后端的活 PTY 直接重新挂回，不要求 kill。
- `coldRestoreBlockedTerminal`：先 kill 旧 PTY 再提交新 PTY；kill 失败时回滚引用且不提交。
- `usePanesStore` legacy-daemon cold restore：解除旧引用后可在成功时清除阻断，失败时完整回滚。
- `terminalService`：读取快照后保留此前探测到的进程内 backend 模式。
- `TerminalTabContent`：legacy-daemon 阻断页提供冷恢复按钮；按钮点击失败的错误展示。

**合并前必须人工实测**（`docs/81` 第 5 节验收标准）：

- [ ] 异常结束应用 → 保留旧 daemon → 重新打开 → 点击「结束旧终端并恢复」
- [ ] 确认旧 PID 退出，且**仅出现一个新**的 resume 进程
- [ ] 杀掉旧 daemon 时不应误启动第二个进程
- [ ] Windows 桌面实测

### #5 `feat(cli-adapter): Claude Provider 通过 --settings 文件注入环境变量`

**问题**：Managed Provider 的环境变量（API key / base URL / model）原本只在进程环境里传给 Claude CLI。Claude CLI 启动后会读 user-scoped `settings.json`，user-level 的 `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / 模型选择会**覆盖** Managed 值，导致 user 配置的第三方 Provider 被悄悄切回 Anthropic 直连。

**修复**：

- `ClaudeAdapter.generate_provider_settings`：取 `adapter_options[__ccpanesProviderEnv]` 的 Managed env JSON；显式 **reset** 所有 routing 相关 env key（缺失补空串），把 model id 写入 `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_{SONNET,HAIKU,OPUS}_MODEL` / `CLAUDE_CODE_SUBAGENT_MODEL` 五个 key；原子写入 `<data_dir>/claude-provider-<sessionId>.json`；`cleanup_stale_provider_settings` 清理 >1h 的同前缀旧文件。
- `build_command` 在 `--dangerously-skip-permissions` 前追加 `--settings <path>`，让 CLI 用 settings 文件覆盖 user-level env。
- `cc-cli-adapters/src/lib.rs` 新增常量 `MANAGED_PROVIDER_ENV_OPTION = "__ccpanesProviderEnv"`（internal 通道，含 credentials，永不日志、永不进 CLI args）。
- `terminal_service.rs` 在 `cli_tool == Claude && ProviderMode::Managed` 时把 provider env JSON 注入 `adapter_options[MANAGED_PROVIDER_ENV_OPTION]`。
- `provider_resolver.managed_provider_conflict_env_keys` 加 5 个 model env key，让冲突检测包含 model 字段。

**测试**：
- `ClaudeAdapter.build_command_overrides_user_routing_with_managed_provider_settings`：检查生成的 settings.json 含 base URL / model / subagent_model，且 `ANTHROPIC_AUTH_TOKEN` 被清空；确认 args 里没有泄露 provider secret。
- `provider_resolver.managed_conflict_lists_are_cli_scoped_and_never_apply_to_shell`：确认 `ANTHROPIC_MODEL` / `CLAUDE_CODE_SUBAGENT_MODEL` 加入冲突列表。

---

## 文件清单（46 项）

**新增 (5)**：
- `docs/81-abnormal-exit-session-recovery.md`
- `web/components/panes/TerminalStatusBar.tsx`
- `web/components/panes/TerminalStatusBar.test.tsx`
- `web/hooks/coldTerminalRestore.ts`
- `web/stores/terminalColdRestoreActions.ts`

**修改 (41)**：
- `cc-cli-adapters/src/claude.rs`、`cc-cli-adapters/src/lib.rs`
- `cc-panes-core/src/models/settings.rs`
- `cc-panes-core/src/services/provider_resolver.rs`
- `cc-panes-core/src/services/terminal_service.rs`
- `web/components/ContextUsageIndicator.tsx`、`ContextUsageIndicator.test.tsx`
- `web/components/StatusBar.tsx`
- `web/components/panes/Panel.tsx`、`Panel.test.tsx`
- `web/components/panes/TabContentRenderer.tsx`、`TabContentRenderer.test.tsx`
- `web/components/panes/TerminalTabContent.tsx`、`TerminalTabContent.test.tsx`
- `web/components/providers/ProviderFormPanel.tsx`、`ProviderFormPanel.test.tsx`
- `web/components/providers/ProviderModelsEditor.tsx`
- `web/components/providers/ProvidersPanel.tsx`、`ProvidersPanel.test.tsx`
- `web/components/settings/TerminalSection.tsx`、`TerminalSection.test.tsx`
- `web/components/settings/settingsRegistry.ts`
- `web/hooks/useContextUsagePoller.ts`、`useContextUsagePoller.test.ts`
- `web/hooks/useTerminalSessionRestore.ts`、`useTerminalSessionRestore.test.ts`
- `web/i18n/locales/{en,zh-CN}/panes.json`
- `web/i18n/locales/{en,zh-CN}/settings.json`
- `web/services/terminalService.ts`、`terminalService.test.ts`
- `web/stores/panesStoreTypes.ts`
- `web/stores/useContextUsageStore.ts`、`useContextUsageStore.test.ts`
- `web/stores/usePanesStore.ts`、`usePanesStore.test.ts`
- `web/stores/useSettingsStore.ts`、`useSettingsStore.test.ts`
- `web/test/utils/testData.ts`
- `web/types/settings.ts`

---

## 历史 commit 清单（dev_zhengjunkj 之前累积、随本次一并合入）

这 6 个 commit 不是本次任务产出，但 dev_zhengjunkj 分支比 main 多出来的内容会一起进入本 PR：

| SHA | 标题 |
|-----|------|
| `82ef428` | fix(frontend): 懒加载分片取回失败不再让整个窗口变成错误页 |
| `f6ffe8f` | feat(theme): 多主题预设 + 实时预览 + 壁纸预览面板 |
| `ec20f1f` | feat(terminal): 终端路径链接对话框 |
| `d7a7c33` | fix(provider): 上下文窗口与用量显示修复 |
| `335e532` | chore: package-lock 清掉 npm 报为冗余的可选依赖条目 |
| `fec759c` | feat(provider): 模型行支持常用容量预设 + 整齐 Label/控件 布局 |

如果 main 已经 cherry-pick 过其中部分，请 reviewer 留意 diff 中可能存在的重复；如果这 6 个 commit 已经在 main 上，请开 PR 前先 revert 它们避免回退。

---

## 验证

- ✅ Rust：`cc-panes-core` 6 settings 测试 + `cc-cli-adapters` 1 测试 + `provider_resolver` 1 测试通过
- ✅ Vitest：14 文件 224 测试全绿
- ✅ 全部 i18n 中英文案齐备，无 fallback
- ⚠️ #4（冷恢复）需合并前按 `docs/81` 第 5 节人工实测 Windows 桌面

## 相关文档

- `docs/81-abnormal-exit-session-recovery.md` —— 冷恢复的设计决策、用户文案、验收标准

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

---

## 创建步骤（手动）

1. 打开 https://github.com/wuxiran/cc-pane/compare/main...dev_zhengjunkj
2. **base**：`main`
3. **compare**：`dev_zhengjunkj`
4. 标题填上面「标题」段落的第一个（或任选一条）
5. body 把「` ```markdown ` ` ``` 」包裹的整段贴进去
6. 提交

如果你想拆 5 个 PR，每个 PR 自己挑一个 commit（PR 网页里 base 选 main、compare 选对应的 commit SHA，可以在 compare 页面 URL 后加 `?expand=1` 看到「commit list」按钮切换）。