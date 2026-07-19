# 分屏落位修复：多余空标签 + 螺旋方向

> 状态：待实施 | 基线提交：`6a29b61` | 关联：`.claude/commands/ccbook/launch-task.md`

## ⚠️ 并发警告

**当前有另一个 worker 正在同一工作树里改代码**，范围是
`web/components/providers/` 与 `web/components/resources/` 及对应 Rust provider service。

本任务的 worker 必须：

- 不读写上述两个目录下的任何文件
- 跑测试时若见 providers/ 或 resources/ 相关失败，**那不是本任务造成的**，
  忽略并在汇报中注明；只对本任务改动涉及的测试负责
- **不做任何 git 写操作**（`add` / `commit` / `stash` 都会波及对方改动）

## 基线

分支 `design/refined-tokens`，基线提交 `6a29b61`。直接在主仓库改，不开 worktree。

---

## 任务 1：修掉 beside 分屏时多出来的空 "Terminal" 标签

**现象**：通过 MCP `launch_task` 以 `placement: "beside"` 启动 worker 时，
新窗格出现两个标签——一个多余的空 "Terminal" 标签 + 预期的 worker 标签。

**根因**：`web/stores/usePanesStore.ts:1331`

```ts
// 新窗格：建好就把新会话作为其唯一（激活）标签，避免先空屏再落会话。
const newPane = createPanel();      // ← createPanel() 自带一个默认 "Terminal" 标签
const newTab = createTab(opts);
newPane.tabs.push(newTab);          // ← push 而非替换，于是变成 2 个
newPane.activeTabId = newTab.id;
```

`createPanel` 定义在同文件 `:55-68`，无参调用时会造一个
`customTitle: "Terminal"` 的默认标签（`:60`）。这段代码的注释描述的是正确意图，
实现漏了——注释与实现不一致。

**修法**：`createPanel(createTab(opts))`（走 `tab ||` 分支），
或 `newPane.tabs = [newTab]` 替代 push。选更清晰的一种。

**不要误改**：同文件 `:1249`（`split`）与 `:1408`（`closePane` 根节点兜底）
也调用 `createPanel()`，但那两处**是有意要一个空 Terminal 标签的**，属正常行为。

**只影响 beside**：`placement: "tab"` 走 `addTab`（`:1508-1519`），不经过此路径。

**补测试**：为 `openSessionBesidePane` 新建窗格的情形加断言——新窗格 `tabs.length === 1`。

---

## 任务 2：launch_task 自动分屏改成螺旋（右、下、右、下交替）

**现状**：`web/hooks/useOrchestratorListener.ts:208` 写死 `"right"`，
连续派 worker 会一直横向铺开。

**类型**：`SplitDirection = "right" | "down"`（`web/types/pane.ts:42`）；
树节点 `SplitPane.direction: "horizontal" | "vertical"`（`pane.ts:20-26`）。
`SplitDirection → SplitPane["direction"]` 的映射表在 `usePanesStore.ts` 里重复了 4 次
（`:1236-1240`、`:1295-1299`、`:1740` 附近、`:2014-2017`）。

**渲染侧无需改动**：仓库没有 Allotment 依赖，实际是自研
`web/components/panes/SplitView.tsx`（flexbox，`:137` `flexDirection`），
经 `SplitContainer.tsx:39` 由 `pane.direction` 数据驱动。

**推荐实现**：在 `openSessionBesidePane`（`usePanesStore.ts:1294`）支持
`direction: "auto"`，按父容器方向取反——父 `horizontal` → 选 `"down"`，
父 `vertical` → 选 `"right"`。再把 `useOrchestratorListener.ts:208` 改成传 `"auto"`。

现有插入逻辑 `:1348-1365` 已处理"同方向同级追加 / 不同方向包新 split"，
正是螺旋所需行为，直接复用。

**陷阱**：`:1348-1351` 的"单 child 壳"分支会改写父容器 direction
（`parent.direction = splitDirection`）。做交替判断前必须先 `unwrapShell`
（`usePanesStore.ts:792-798`），否则第一次分屏会读到壳的陈旧 direction、方向判断出错。

**不要动**：`web/components/panes/Panel.tsx:285/290` 的用户手动 splitRight/splitDown
（用户显式选的方向，不该被自动逻辑覆盖）；`buildPresetTree`（`:749-789`）的固定预设。

**补测试**：连续三次 `openSessionBesidePane(..., "auto", ...)`，断言方向序列交替。

---

## 可选（判断后决定，别擅自扩大）

`web/utils/paneTreeHelpers.ts:9-32` 有一份**重复的 `createPanel`** 实现
（`:18` 同样硬编码 `title: "Terminal"`），目前只被测试文件引用。
两份并存是隐患，但合并需确认所有引用点。**30 分钟内搞不定就跳过**，
在汇报里标为待办——不要为此拖慢主任务。

## 验收

- `npx tsc --noEmit`
- `npm run test:run -- --maxWorkers=3`（高负载下 vitest 偶发 fork 超时假失败，重跑再判）
- 本任务改动涉及的测试必须绿；providers/resources 相关失败不计
