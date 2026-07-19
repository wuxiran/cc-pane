# 22. 前端设计重构：组件化 + 设计语言对齐 + UX 补全

> 状态：进行中（design/refined-tokens 分支）。
> 设计基准：`docs/prototypes/filemodel.html`（浅色 ModernEditor 原型）。
> 本文档是该轮重构的落地规范：分区与背景所有权、色彩语义分类与映射表、拆分索引、UX 组件使用约定。经 WSL Codex 同行评审（10 条必修 + 3 条开放决议）修订。

## 1. 设计语言（源自 demo 原型）

- **三级明度分层**代替重边框划分区域：外框最深 → 侧栏次深 → 主区最亮。
- **发丝边框**：`--app-border`（半透明 rgba），不用实色重描边。
- **柔和 elevation**：`--sh-sm/md/lg` 三级阴影 + `--hi` 顶部内高光；亮色近零阴影。
- **细描边图标**：lucide `strokeWidth={1.5}`。
- **激活态**：accent 竖条（ActivityBar 左缘 3px `rounded-r-md`）或下划线（TabBar），配轻背景，不用整块高亮。
- **交互隐藏化**：次要操作按钮 `group-hover` 才浮现。
- **动效 token**：`--ease-out`（cubic-bezier 0.16,1,0.3,1）+ `--dur-fast/dur/dur-slow`（120/160/240ms）。
- **字体**：Inter Variable（打包 woff2），`font-feature-settings: "cv02","cv03","cv04","ss01"`。

## 2. 布局分区与背景所有权

五区骨架（`web/components/layout/AppShell.tsx`）：

```
TitleBar        --app-menubar          （最深，外框）
ActivityBar │ Sidebar     │ Main
--app-activity-bar-bg（最深）
            │ --app-sidebar-bg（次深）
                          │ --app-panel-bg（最亮）
StatusBar       --app-menubar          （最深，外框）
```

- **背景所有权**：各区组件自绘背景，但**必须**取对应 `--app-*` token；分区容器与区间边框归 `AppShell`/`MainViewSwitcher`。禁止组件内 inline 硬编码背景色。
- **暗色明度三档**（必须可辨）：activity-bar `#0A0B0D` < sidebar `#111318` < panel `#16181D`。
- `MainViewSwitcher` 收拢 `useActivityBarStore` 全部 8 个 `appViewMode`；orchestration 是 "panes + overlay" 兼容态；**切换即卸载**是既定语义（终端保活属独立变更，未在本轮范围）。

## 3. 色彩语义四分类与映射表

新增/既有 token（`web/assets/index.css`，亮暗双套）：

| token | 用途 |
|---|---|
| `--app-status-success/warning/danger` (+`-bg`/`-border` 派生，color-mix 随主题) | 状态色 |
| `--app-accent` | 信息/运行中/链接/激活 |
| `--app-identity-wsl` / `--app-identity-ssh` | 身份色（"是什么"而非"什么状态"） |
| `--app-text-primary/secondary/tertiary`、`--app-border`、`--app-hover`、`--muted` | 中性 |

迁移映射（`dark:` 双写一律折叠为单 token 类）：

| 旧硬编码 | 语义 | 新写法 |
|---|---|---|
| green/emerald-* | status | `text-[var(--app-status-success)]`，底 `bg-[var(--app-status-success-bg)]` |
| amber/yellow-*（警示） | status | `--app-status-warning`(+`-bg`/`-border`) |
| red/rose-* | status | `--app-status-danger`(+`-bg`/`-border`) |
| blue-*（信息/运行中） | status | `--app-accent`，底 `bg-[color-mix(in_srgb,var(--app-accent)_12%,transparent)]` |
| amber（WSL 徽章）/cyan（SSH 徽章） | identity | `--app-identity-wsl` / `--app-identity-ssh`，徽章模式：`bg-[color-mix(...14%,transparent)] text-[var(...)] border-[color-mix(...30%,transparent)]` |
| slate/gray-400 → -500/600 → -700/900 | neutral | `--app-text-tertiary` → `-secondary` → `-primary` |
| bg-gray-100 徽章底 / hover 底 | neutral | `var(--app-hover)` 或 `var(--muted)` |
| bg-white 面板 / 浮层 | neutral | `--app-panel-bg` / `--app-overlay` |
| border-gray-200 | neutral | `--app-border` |

**允许保留（allowlist）**：文件扩展名内容色（FileTreeNode）、进程类型 categorical 4 色（ProcessMonitorSection）、装饰性标记（默认发行版金色星标）、实心色底上的 `text-white` on-color 前景。防回潮由 `web/components/designTokens.test.ts` 静态扫描守护（排除 `*.test.*`、`mobile/`、`ui/`；allowlist 文件+类名粒度，条目失效也报错）。豁免目录：`mobile/`（原型页）、`ui/`（shadcn 基件）。

## 4. 巨石拆分索引

### App.tsx（1274 → ~97 行）

| 模块 | 内容 |
|---|---|
| `web/utils/desktopRuntime.ts` | `resolveRuntimeKind` / `waitForDesktopRuntime` |
| `web/hooks/useSessionLayoutPersistence.ts` | 布局快照持久化 + 跨端同步（两个 hook 共享**模块级单例**可变状态，勿改成组件 state） |
| `web/hooks/useTerminalSessionRestore.ts` | **terminal-sensitive**：后台布局恢复（出队重检防重复建会话）、daemon 重挂载、history-updated→resumeId 回写桥（退避重试）。改动须过其专项测试 |
| `web/hooks/useAppLifecycleEarly.ts` / `useAppLifecycleLate.ts` | 原 App effects 按注册时序分组；顺序由 `useAppLifecycle.order.test.tsx` 特征测试锁定，调整前先证明顺序无关 |
| `web/hooks/useShortcutRegistrations.ts` | 全局快捷键动作注册 |
| `web/hooks/useOpenTerminal.ts` | 打开终端 + pendingLaunch 消费 |
| `web/components/layout/` | AppShell / MainViewSwitcher / AppDialogs / DarkOrbsBackground / MobilePrototypeRoute |

### LayoutBar（862 → layoutbar/ 6 模块）

入口按钮 + LayoutSelectorPanel + SortableLayoutRow + LayoutDeleteDialog + useLayoutSelectorState + useFloatingPanelPosition。旧路径 `web/components/LayoutBar.tsx` 保留 **default + `LAYOUT_BAR_TOGGLE_EVENT`** re-export（ActivityBar 默认导入、快捷键常量、测试 mock 依赖它）。LayoutDeleteDialog 的 detach→kill→关弹窗→删布局是顺序敏感副作用，有专项测试。

### LocalHistoryPanel（643 → localhistory/ 5 模块）

Dialog 壳 + useLocalHistoryData（21 个 useState 收拢）+ VersionListSidebar + VersionDiffView + LabelDialog。旧路径 re-export default。

## 5. UX 组件使用约定

- **Tooltip**：图标按钮一律用 `ui/IconTooltipButton`（自带 aria-label + 可选 `kbd` 快捷键徽标），不再用原生 `title=`。
- **空状态**：用 `ui/EmptyState`（icon + title + description + 可选 CTA）。
- **加载态**：用 `ui/skeleton` 拼贴合布局的骨架行，不用纯文字"加载中"。
- **命令面板**：`Ctrl+K`（action id `command-palette`，Rust/TS 双端默认绑定，`merge_missing_defaults` 自动合入存量配置）。聚合已注册快捷键动作/工作空间跳转/布局切换。**终端聚焦时放行给终端**（在 `TERMINAL_PASSTHROUGH_ACTIONS`）。
- **动效**：过渡统一 `transition-colors duration-[var(--dur-fast)]`（或 `--dur`/`--dur-slow`），缓动 `--ease-out`；卡片 hover 阴影 `--sh-sm → --sh-md`。

### 动效准则（采纳 emilkowalski/skills design-eng 规则）

- **缓动 token**：`--ease-out: cubic-bezier(0.23,1,0.32,1)`（进入/退出）、`--ease-in-out: cubic-bezier(0.77,0,0.175,1)`（屏上移动/形变）；**UI 永不使用 ease-in**。
- **键盘唤起零动画**：命令面板（Ctrl+K）、最近文件（Ctrl+E）等高频键盘入口不做入场/离场动画（Raycast 式）。
- **按压反馈**：可按元素 `active:scale(0.96~0.98)` + transform 过渡（ui/button、ActivityBar 图标、IconTooltipButton 已内置）。
- **退出快于进入**：Dialog 进场 200ms、离场 `--dur-fast`(120ms)。
- **入场不从 scale(0) 开始**：用 zoom-95 + fade（shadcn 预设已符合）；popover 族 transform-origin 必须锚定 trigger（radix var）。
- **只动画 transform/opacity**（性能）；`transition: all` 一律收窄到具体属性。
- **prefers-reduced-motion**：keyframe 位移入场直接跳过、transition 收短到 60ms（减弱而非归零，index.css 全局规则）。

## 6. 已评审决议（Codex 同行评审拍板记录）

- Ctrl+K：终端聚焦放行；非终端焦点打开面板。
- Sidebar 显隐动画：过渡 wrapper、过渡结束后卸载；终端尺寸适配依赖 TerminalView 现有 ResizeObserver 调度器，**不另发 resize 事件**；若实测抖动则放弃动画。
- MainView 切换：保持卸载语义；终端保活另行评审。
- StrictMode 已在 `web/main.tsx` 主入口启用；新终端类组件必须容忍双挂载。

## 7. 红线（不因本轮重构而松动）

- TerminalView 渲染生命周期、`terminal_service` 的 CR（`\r`）提交、OSC/hook 会话状态链路一概不碰。
- terminal-sensitive hook（`useTerminalSessionRestore`）改动必须过"不重复建会话 / 重试仍回写"专项测试并走查 `[SessionRestore]`/`[BackgroundRestore]` 日志。
