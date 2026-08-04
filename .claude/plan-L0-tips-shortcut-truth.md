# L0 · 快捷键真值修复：tips 文案限制 + Ctrl+W 漏杀会话

> 来源：docs/67 发现性计划的前置修复。**必须在 tips 扩容（L2）之前完成**，
> 否则错误形态会被复制 10 份。
>
> 本 plan 由 leader 派发，worker 在独立 worktree 中执行。

## 背景

docs/58 §1.1 立下的原则：

> **教错快捷键比不教更糟：用户按一次没反应就再也不信 tip 了。**

当前实现正在违反这条原则。本 plan 修两个同源问题，都在「快捷键路径与主路径语义不一致」这条线上。

---

## 任务 1 · tips 教的快捷键在终端聚焦时失效

### 事实

`web/stores/useShortcutsStore.ts:16-24` 定义 `TERMINAL_PASSTHROUGH_ACTIONS`，
终端聚焦时把这些快捷键放行给终端自己处理（源码注释逐条写了与 Claude Code TUI /
readline 的冲突理由）。清单含 7 条：

```
toggle-sidebar / new-tab / close-tab / toggle-mini-mode /
split-right / split-down / command-palette
```

放行发生在两处：`handleKeydown:150-152` 与 `shouldTerminalHandleKey:178-180`。

而 `web/components/tips/featureTipRegistry.tsx` 注册的 4 条 tip 中，**3 条的
actionId 恰好都在这个清单里**：

| tip id | actionId | 默认键位 | 在放行清单 |
|---|---|---|---|
| `command-palette` | `command-palette` | Ctrl+K | ✅ |
| `unified-launcher` | `new-tab` | Ctrl+T | ✅ |
| `mini-mode` | `toggle-mini-mode` | Ctrl+M | ✅ |
| `layout-switcher` | `toggle-layouts` | Ctrl+Alt+L | ❌ |

CC-Panes 的默认状态就是终端聚焦，所以用户照 tip 按下去，什么都不会发生。

### 已决定的修法（用户已拍板）

**不动产品行为，不改放行清单。** 在 tip 文案里说清楚这个限制。

理由：放行清单的每一条在源码注释里都有具体的 TUI 冲突理由，动它属于产品决策，
不在本次范围内。这一条已作为条目记入 docs/68（交互体验计划），本轮不做。

### 实现要求

**不要在 4 条 tip 的文案里各自手写一句提示。** 那样会随放行清单变化而腐烂——
清单改了、tip 文案不会跟着改，就又回到「教错快捷键」。

正确做法是**从 `TERMINAL_PASSTHROUGH_ACTIONS` 派生**：

1. 从 `useShortcutsStore` 导出 `TERMINAL_PASSTHROUGH_ACTIONS`（或一个
   `isTerminalPassthroughAction(actionId): boolean` 判定函数）。优先导出判定函数，
   不要把裸数组暴露出去。
2. 在 `web/components/tips/FeatureTip.tsx` 里，当 `tip.actionId` 命中该判定时，
   在键位 chip 附近或正文下方渲染一句限制说明。
3. 该说明是**独立的 i18n key**（如 `featureTips.terminalPassthroughHint`），
   一份文案供所有命中的 tip 复用，不是每条 tip 各写一份。

### 文案要求

- 说清楚「什么时候不生效」和「怎么才能生效」，不要只说「可能无效」。
- 参考语义：终端聚焦时该快捷键会交给终端处理；先点击终端以外的区域再按。
- **双语硬约束**（docs/46 §7）：`web/i18n/locales/en/settings.json` 与
  `zh-CN/settings.json` 必须同批加，namespace 是 `settings`。

### 视觉要求

- 遵守 docs/46 §6.1：`GuidedDialog` 右栏演示对读屏隐藏（`aria-hidden`），
  **所有信息必须同时在左栏文字中可获得**——所以这句说明必须放左栏，不能只做成视觉标记。
- 用现有 `var(--app-*)` token，不要引入新颜色。
- 这是限制说明不是错误，**不要用红色**。参考 docs/46 的琥珀约定判断是否该用琥珀，
  若判断不该用就走次级文字色。

### 已有的降级机制别破坏

`FeatureTip.tsx:24-30` 已实现「未绑定快捷键时隐藏 chip + 换 `bodyUnboundKey` 文案」。
新增的限制说明要与这个机制**正交**：未绑定时不该同时冒出「终端聚焦会失效」
（都没绑定，谈不上失效）。

---

## 任务 2 · Ctrl+W 漏杀分屏会话且绕过 dirty 确认

### 事实

同一个「关闭标签」动作有两条路径，语义不同：

**鼠标点标签 ×** — `web/components/panes/Panel.tsx:154-182`
```
handleCloseTab:
  if (tab.pinned) return                      // pinned 保护
  if (tab.dirty) setDirtyConfirmTabId(...)    // 脏标记确认
  doCloseTab: collectTerminalSessionIds(tab)  // 收集【全部】 sessionId 逐个 kill
```

**Ctrl+W** — `web/hooks/useShortcutRegistrations.ts:99-114`
```
terminalService.killSession(tab.sessionId)    // 只杀【单个】 sessionId
  .catch(console.error)                       // 裸 console.error
s.closeTab(...)                               // 无 pinned 检查、无 dirty 确认
```

### 三个后果

1. **孤儿 PTY**：分屏标签里非 `tab.sessionId` 的那些 PTY 没被 kill，在 daemon 里
   继续活着。CLAUDE.md 记录 daemon 是跨 app 重启存活的锚点——这些会话不会自己消失。
2. **静默丢数据**：未保存的编辑标签被 Ctrl+W 直接关掉，无确认。
3. **pinned 失效**：钉住的标签能被 Ctrl+W 关掉。

### 修法

让 Ctrl+W 走与鼠标点 × **完全相同**的路径，不要在 handler 里复制一份逻辑
（复制就会再次漂移）。

推荐方向（worker 自行判断哪个在本代码库更自然）：
- 把 `Panel.tsx` 的 `handleCloseTab` 提升为可被快捷键调用的共享入口
  （store action / 自定义事件 / context），`close-tab` handler 只负责找到当前 tab 并调它；
- 或参照 `command-palette`、`toggle-layouts` 已有的**事件派发**模式
  （`useShortcutRegistrations.ts:120-129`），由 Panel 侧监听并执行既有逻辑。

**硬要求**：修完后 Ctrl+W 必须与鼠标点 × 在这三点上行为一致——pinned 保护、
dirty 确认、`collectTerminalSessionIds` 全量 kill。

### 错误处理

`.catch(console.error)` 是 `web/` 里唯一一处裸 console.error catch。
按 CLAUDE.md「错误显式处理，不 swallow」，kill 失败应给用户可见反馈
（参考同文件 `voice-input` 失败走 toast 的写法，`useShortcutRegistrations.ts:55-80`）。

---

## 验收

### 必跑（按 CLAUDE.md 的判定纪律）

```
npx tsc --noEmit
npm run test:run
```

**不要用 `| tail`**。CLAUDE.md 明写管道会掩码退出码，把失败报成通过。
判定成败必须看真实退出码，或干脆不加管道。

若 vitest 报 fork 超时类 Errors，按已知情况用 `--maxWorkers=3` 重跑再判，
不要直接判失败。

### 测试要求

`web/components/tips/` 下已有 `FeatureTips.test.ts` / `FeatureTip.test.tsx`。
两个任务各补测试：

- 任务 1：actionId 在放行清单内 → 渲染限制说明；不在清单内 → 不渲染；
  未绑定快捷键时 → 不同时渲染限制说明。
- 任务 2：Ctrl+W 对 pinned 标签不关闭；对 dirty 标签走确认；对分屏标签
  kill 了全部 sessionId（断言 killSession 调用次数与 id 集合）。

### 自查清单

- [ ] en 与 zh-CN 两份 locale 都加了新 key，且 key 路径一致
- [ ] 没有硬编码中文或英文字面量进组件
- [ ] 限制说明的信息在左栏文字中可获得（不只是视觉标记）
- [ ] Ctrl+W 与鼠标点 × 三点行为一致
- [ ] 没有引入新的裸 `console.error`

---

## 边界（不要做）

- **不要改 `TERMINAL_PASSTHROUGH_ACTIONS` 的内容**。用户已明确选择不动产品行为。
- **不要新增 tip 条目**。扩容是 L2 的事，本 plan 只修正确性。
- **不要给 `FeatureTipDefinition` 加落点链接字段**。那是 L2 的第一步改动，
  两条线都改这个结构会冲突。
- **不要重构快捷键体系**（冲突检测、恢复默认、搜索等）。那些已记入 docs/68。
- **不要提交 git**，除非 leader 明确指示。

## 收尾

按 docs/65 观测契约上报。完成时必须包含：
改了哪些文件、两条命令的真实退出码、新增测试数与通过情况、
以及任何你判断偏离了本 plan 的地方及理由。
