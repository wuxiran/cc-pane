# 「最近启动」从 ActivityBar 迁到 Explorer 顶部图标 tab

> 状态：待实施 | 基线：工作树内有十个 worker 的未提交改动，**不要动它们**

## ⚠️ 并发警告

**另有 worker 正在改** `web/components/TitleBar.tsx`、`web/components/home/HomeDashboard.tsx`，
以及 i18n 的 `common.json` / `sidebar.json` / `home.json`。

**因此本任务原则上不要编辑任何 i18n 文件**——见下方「i18n 约束」。

**只许碰**：

- `web/components/ActivityBar.tsx`
- `web/components/sidebar/ExplorerView.tsx`
- 必要时 `web/components/sidebar/` 下与 sessions 视图渲染相关的文件
- 对应 `*.test.tsx`

**不要碰**：`web/components/TitleBar.tsx`、`web/components/home/`、
`web/components/panes/`、`web/components/launcher/`、`web/components/providers/`、
`web/stores/useActivityBarStore.ts`（除非确实绕不开，见下）。
**禁止任何 git 写操作**。

## 需求

「最近启动」目前是 ActivityBar（最左侧竖排）的一个时钟图标项，点击后在左侧栏显示。
用户希望把它**从左侧竖排移除**，改为 Explorer 面板**顶部图标 tab 组**中的一项。

## 现状定位

- **ActivityBar 项**：`web/components/ActivityBar.tsx:102`
  ```tsx
  { view: "sessions", icon: <History className="w-[22px] h-[22px]" strokeWidth={1.5} />, label: t("recentLaunches") }
  ```
- **Explorer 顶部图标 tab 组**：`web/components/sidebar/ExplorerView.tsx:78-111`
  —— `SECTIONS` 数组 + `role="tablist"`，选中态为
  `color-mix(in srgb, var(--app-accent) 12%, transparent)` 底 + accent 字色，
  按钮尺寸 `h-[26px] w-[28px] rounded-md`，图标 `h-[15px] w-[15px] strokeWidth={1.8}`。
  **新增项必须完全沿用这套样式**，不要另起一套。
- Explorer 头部同一行还有 EXPLORER 标题和一个火箭按钮（`:64-77`，
  那是另一个 worker 刚加的启动器入口，**保留不动**）。

## 改动

1. 在 `ExplorerView.tsx` 的 `SECTIONS` 里新增「最近启动」项（`History` 图标），
   并在内容区渲染对应的 sessions 视图。
2. 从 `ActivityBar.tsx:102` 移除该项。

## ⚠️ 三个必须先确认的耦合点

动手前请逐一查清并在汇报里说明结论：

1. **sessions 视图组件的 props**：现在由 ActivityBar 驱动的 sessions 视图
   （`web/components/sidebar/SessionsView.tsx`，内部用 `RecentLaunches.tsx`）
   接收 `onOpenTerminal` 等 props。迁进 Explorer 后这些 props 从哪来？
   `ExplorerView` 当前拿得到吗？拿不到的话需要沿 props 链补——
   **但绝对不要在 ExplorerView 里挂 `useOpenTerminal`**
   （架构硬约束：全应用只有 `App.tsx:88` 一处挂载，重复挂会导致
   `pendingLaunch` 双消费，见 `LauncherDialog.tsx:2-3` 的注释）。

2. **`activeView === "sessions"` 的残留引用**：`useActivityBarStore.ts` 里有多处
   按 `activeView` 分支的逻辑。从 ActivityBar 移除按钮后，
   store 里保留 `"sessions"` 这个取值**通常是无害的**（只是没人再切到它）。
   **优先不改 store**。若发现确实有逻辑会因此失效（例如持久化恢复时
   `activeView` 仍是 `"sessions"` 导致侧栏空白），
   **停下来在汇报里说明，不要擅自改 store**。

3. **keep-alive 结构**：`ExplorerView.tsx:114` 起的内容区注释写明
   「工作空间视图：keep-alive，隐藏而不卸载（WorkspaceDialogs 挂在树内）」。
   新增 section 的内容渲染要遵循同样的 keep-alive 模式，
   不要用条件卸载——否则切走再切回会丢状态。

## i18n 约束

**优先复用已有的 `recentLaunches` key**（ActivityBar 现在就在用），
这样本任务无需编辑任何 i18n 文件，避开与另一个 worker 的冲突。

若你判断确实需要新 key，**不要自行添加**——在汇报里提出，由 leader 协调后另派。

## 验收

- `npx tsc --noEmit`
- `npx vitest run web/components/ActivityBar.test.tsx web/components/sidebar/ExplorerView.test.tsx --maxWorkers=2` 全绿
  （`ExplorerView.test.tsx` 有另一个 worker 刚加的启动按钮断言，**必须继续绿**）
- 补测试：Explorer 顶部 tab 组包含「最近启动」；ActivityBar 不再包含 sessions 项
- 手动：Explorer 顶部能切到最近启动并正常显示历史；左侧竖排不再有时钟图标；
  切走再切回不丢状态
