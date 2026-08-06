你是独立同行评审者。只读评审，不要改任何代码。

## 评审对象

Plan 文件（只审 **阶段 P1 · 可见性双写拆除** 一节，其余节忽略）：

/mnt/c/Users/wuxiran/.claude/plans/0-12-0-resilient-journal.md

## 背景

仓库：/mnt/d/04_workspace_rust/cc-book（分支 feat/0120-tab-lifecycle）。
docs/78 批2 建立了可见性单一事实源 useTabViewStateStore（键 owner:role，
三档 active/visible/hidden，聚合 anyVisible），旧口径（isVisible/isActive/
layoutActive 三 props + TerminalView 三 ref）以双写 + 漂移断言并存至今。
P1 要把旧口径整体拆除。

## 请逐个核对的代码文件

- web/components/panes/TerminalView.tsx（三 ref、isRenderVisible、8 个消费点）
- web/components/panes/Panel.tsx（useReportPaneVisibility 写侧 + 三 props 传递）
- web/components/panes/TerminalTabContent.tsx（isActive 掺 leaf 焦点的那行）
- web/components/panes/TabContentRenderer.tsx / BrowserTabContent.tsx
- web/components/panes/PopupTerminalWindow.tsx / selfchat/SelfChatManager.tsx /
  StarredMirrorTile.tsx（isActive={true} 硬编码与各自的 store 写侧）
- web/components/panes/useDowngradeVisibility.ts / visibilityDriftAssert.ts /
  useReportPaneVisibility.ts
- web/stores/useTabViewStateStore.ts
- web/stores/paneRemovalActions.ts（六个 @deprecated 出口）
- web/components/panes/useTerminalHibernation.ts（休眠判据消费聚合）
- web/components/panes/terminalLayoutScheduler.ts（isActive 注入）

## 评审维度（逐条点名）

1. **行号与清单准确性**：plan 里的行号/清单是否与当前代码对得上（分支刚 rebase
   过 PR #55，行号可能漂移）；六个旧出口生产调用方是否真的为 0。
2. **迁移顺序与依赖**：P1-1..P1-5 的顺序有没有依赖倒挂；8 个消费点里有没有
   「必须先于/后于某步」的隐藏耦合。
3. **leafFocused 语义拆分完备性**：isActive 除「可见性」与「tab 内 leaf 焦点
   路由」外，是否还有第三种语义混在里面（如 focus 抢占、快捷键路由）；
   store 侧三档模型能否无损承接每个消费点的判定。
4. **行为红线**：「后台积压→切回补齐」「后台退出补齐尾部」两条测试改造成
   store 驱动后是否仍能覆盖原风险；有没有别的行为红线没被点名。
5. **遗漏项**：还有哪些旧口径消费点/回退表达式/测试没进清单；拆除后哪些
   store 侧回退（useDowngradeVisibility 的 fallback）确实可以收窄、哪些不行。
6. **不变式风险**：docs/71 三不变式（丢弃只能整段/回放过 renderTerminalData/
   休眠唤醒不丢字）在哪几步最可能被破坏，建议的守护测试。

## 输出格式（严格三段）

✅ 已确认稳妥：<点列，每条 1 行>
⚠️ 必修问题：<点列，每条标维度 + 具体文件:行号 + 修改建议>
❓ 开放问题：<点列，每条标维度 + 选项 + 你的倾向>

不要复述 plan 内容，只列具体可执行的修改点。
