# 启动器无视「默认 CLI 工具」设置

> 状态：待实施 | 基线提交：`6a29b61`

## ⚠️ 并发警告

同一工作树内有其它 worker 在改代码。**本任务只许碰**：

- `web/components/launcher/launcherModel.ts`
- `web/components/launcher/LauncherDialog.tsx`
- 对应 `*.test.ts(x)`

**不要碰**：`web/components/sidebar/`（**含 `OrchestratorInput.tsx`**，
有 worker 正在改该目录）、`web/components/panes/`、
`src-tauri/src/services/orchestrator_service.rs`、
`cc-panes-core/src/services/terminal_service.rs`、`web/hooks/useOpenTerminal.ts`。
**禁止任何 git 写操作**。其它目录的测试失败与本任务无关，忽略并注明。

## 现象

CC-Panes 支持 8 个 CLI（`web/types/provider.ts:223-232` `CLI_TOOL_TABS`：
Claude / Codex / Gemini / Kimi / GLM / OpenCode / Cursor / Grok），
设置里也有「默认 CLI 工具」下拉（`web/components/settings/GeneralSection.tsx:157-163`），
Onboarding 还专门问过用户一次（`web/components/OnboardingGuide.tsx:67`）。

**但主启动路径（`Ctrl+T` → LauncherDialog）永远默认 Claude，无视该设置。**

## 根因

`web/components/launcher/launcherModel.ts:63` 把 `cliTool: "claude"` 写死在
`createDefaultDraft` 里：

```ts
export function createDefaultDraft(partial?: Partial<LauncherDraft>): LauncherDraft {
  return {
    source: null,
    cliTool: "claude",     // ← 写死，不读用户设置
    environment: "local",
    ...
  };
}
```

`LauncherDialog.tsx:65` 和 `:85` 两处调用都**没有**传 `cliTool`，
因此永远拿到写死的 `"claude"`。

对比：其它消费方都正确读取了该设置——
`ProvidersPanel.tsx:70`、`SelfChatManager.tsx:15`、`OrchestratorInput.tsx:40`。

## 改动

让 `createDefaultDraft` 的 `cliTool` 优先取 `settings.general.defaultCliTool`，
缺省再回落 `"claude"`。

实现方式二选一，**倾向后者**：

1. `createDefaultDraft` 内部直接读 `useSettingsStore.getState()`——简单，
   但给纯函数引入了 store 依赖，测试要 mock。
2. **保持 `createDefaultDraft` 为纯函数**，由 `LauncherDialog.tsx:65` / `:85`
   两处调用点读设置并作为 `partial.cliTool` 传入。
   `createDefaultDraft` 已经接受 `Partial<LauncherDraft>` 并展开覆盖（`:70`），
   天然支持，改动最小且不破坏现有 19 处测试调用。

注意 `:85` 那处是带 `partial` 的调用，合并时不要覆盖掉调用方已显式指定的 `cliTool`
（若有）——**用户显式选择 > 默认设置 > 硬编码回落**。

### 校验取值合法性

`settings.general.defaultCliTool` 是自由字符串，需校验它在 `CLI_TOOL_TABS` 内，
非法值回落 `"claude"`，避免脏配置导致启动器进入不可用状态。
可复用现有的 `coerceLaunchTool`（`ProvidersPanel.tsx:70` 用过，确认其导出位置后复用，
**不要**在 launcher 里重写一份）。

## 已知的关联问题（本次不做，仅记录）

1. **`OrchestratorInput.tsx:41` 的二元塌缩**：
   `useState(defaultCliTool === "codex" ? "codex" : "claude")`
   —— 把 8 个 CLI 的选择塞进二元判断，默认设成 Gemini 也会被塌缩回 Claude。
   **该文件正被其它 worker 占用，本次不碰**，等其完成后另派。
2. **`useOpenTerminal.ts:35-36`**：
   `opts.cliTool ?? (resumeId ? settings.general.defaultCliTool ?? "claude" : undefined)`
   —— 只有 resume 时才读默认设置；新建会话 `cliTool` 缺省为 `undefined`，
   意味着只开裸 shell 不启动 CLI。这是**有意设计还是遗漏需要确认**，
   本次不动，在汇报里给出你的判断。

## 验收

- `npx tsc --noEmit`
- `npx vitest run web/components/launcher/ --maxWorkers=2` 全绿
  （`launcherModel.test.ts` 有 19 处 `createDefaultDraft` 调用，全部不得回归）
- 补测试：设置为 `codex` 时新建草稿的 `cliTool` 为 `codex`；
  设置为非法值时回落 `claude`；调用方显式传入时不被默认值覆盖
