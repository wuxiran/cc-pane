# 侧栏常驻启动入口 + 工作空间列表固定高度可滚动

> 状态：待实施 | 基线提交：`6a29b61` | 参考：`docs/23-ccpanel-competitor-evolution.md` §2.2 / §3.1

## ⚠️ 并发警告

同一工作树内有其它 worker 在改代码。**本任务只许碰**：

- `web/components/sidebar/` 下与工作空间树/项目列表相关的组件
- 必要的 i18n 文件（`web/i18n/locales/{zh-CN,en}/sidebar.json`）
- 对应 `*.test.tsx`

**不要碰**：`web/components/providers/`、`web/components/resources/`、
`web/stores/usePanesStore.ts`、`web/hooks/useOrchestratorListener.ts`、
`web/components/panes/`、`web/components/launcher/`（启动器本身不改，只调用它）、
`src-tauri/`、`cc-panes-core/`。
**禁止任何 git 写操作**。测试若见上述目录相关失败，与本任务无关，忽略并注明。

## 需求

1. **工作空间列表固定高度 + 可滚动** —— 列表不随内容无限撑高，超出部分内部滚动。
2. **侧栏底部常驻「启动终端」按钮** —— 点击唤起启动器，可灵活选择 Provider 等配置。

## 背景：为什么是"加入口"而不是"造新弹窗"

CC-Panes **已有**完整的全局启动器 `web/components/launcher/LauncherDialog.tsx`，
九个 Section：Project / **Cli** / **Environment** / Scenario / Options / Injection /
**Provider（providerSelection 三态 + 凭证下拉）** / Worktree / Layout，还有实时 Args 预览。
`Ctrl+T` 已经直接唤起它（`web/hooks/useShortcutRegistrations.ts:91-98`）。

**缺的只是一个常驻、显眼的入口**——现在只能靠快捷键或空态触发，用户发现不了。
竞品（`docs/23` §2.2）在左侧栏顶部放了 `＋ 新建终端` 大按钮，
点击弹出快速启动（§3.1：CLI 类型 / 努力程度 / Args 预览 / **API 供应商两级下拉**）。

**所以本任务不新建弹窗、不改启动器**，只加入口。用户要求放在**面板底部**（非竞品的顶部）。

## 改动

### 1. 工作空间列表固定高度可滚动

- 列表容器改为 `flex-1 min-h-0 overflow-y-auto`（`min-h-0` 是 flex 子项能收缩的关键，
  漏掉它会导致 `flex-1` 不生效、容器继续被内容撑高）。
- 侧栏根容器需是 `flex flex-col h-full`，底部按钮 `shrink-0`，中间列表占剩余空间。
- 滚动条沿用全局浮动隐藏式样式（`web/assets/index.css:417-507`，容器 hover 才淡入），
  **不要**给容器加 `.no-scrollbar`（`index.css:617`）——那会让用户完全失去滚动位置感知。

### 2. 底部常驻「启动终端」按钮

- 位置：侧栏最底部，`shrink-0`，与上方列表用 `borderTop: 1px solid var(--app-border)` 分隔。
- 行为：调用 `useDialogStore` 的 `openLauncher`，携带当前上下文
  （`workspaceName`、必要时 `projectPath` / `targetLayoutId`）。
  参考现有调用点写法：`web/components/sidebar/ExplorerView.tsx:58`（顶部火箭图标）、
  `web/components/home/HomeDashboard.tsx:82`。
- **绝对不要**在侧栏组件内挂 `useOpenTerminal` —— 架构约束：全应用只有 `App.tsx:88`
  一处挂载，Dialog/Panel 内再挂会导致 `pendingLaunch` 双消费
  （见 `LauncherDialog.tsx:2-3`、`PanelEmptyActions.tsx:4-5` 的注释）。
- 文案走 i18n，不要硬编码中文。
- 建议在按钮上标注 `Ctrl+T` 快捷键提示，帮助用户建立肌肉记忆
  （项目已有 `ui/IconTooltipButton` 支持 `kbd` 徽标）。

### 3. 样式对齐项目规范

遵守 `docs/22-frontend-design-refactor.md`：

- 禁止 `style={{}}` 里硬编码色，一律用 `--app-*` token
- 过渡统一 `transition-colors duration-[var(--dur-fast)]`
- 主操作按钮用 `--app-accent`（**不要**用绿色——绿色是 status 语义，不是 action）
- 圆角阶梯：行/按钮 `rounded-md`，分组/卡片 `rounded-lg`
- 图标 `strokeWidth={1.5}`
- 次要图标按钮 `group-hover` 才浮现，不要常驻

## 明确不做

- 不改 `LauncherDialog` 及其九段式配置（含 Provider 行）。
- 不做竞品 §3.1 的独立"快速启动小弹窗"——现有启动器已覆盖其全部能力，
  再做一个是重复入口（Provider 面板刚因为同样的错误在返工，见 `docs/24`）。
- 不做 §2.4 的应用级会话状态栏（那是 `docs/23` 的 P0-1，另案）。

## 验收

- `npx tsc --noEmit`
- `npm run test:run -- --maxWorkers=3`
- 补测试：底部按钮点击后 `openLauncher` 被调用且带上了正确的 workspace 上下文
- 手动：工作空间很多时列表内部滚动、底部按钮始终可见不被推出视口；
  窗口高度变化时布局不塌
