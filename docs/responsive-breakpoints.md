# 响应式断点映射表与走查清单

CC-Panes 主界面采用五档断点，与 Tailwind 默认断点对齐（`web/lib/breakpoints.ts` 是唯一事实源，JS 侧用 `useBreakpoint` / `useMediaUp`，CSS 侧用 `sm:`/`md:`/`lg:`/`xl:` 前缀，二者永不漂移）。

## 断点映射表

| 档位 | 宽度区间 | 典型场景 | 布局策略 |
|------|----------|----------|----------|
| xs | < 640px | 迷你窗、贴边半栏窗 | ActivityBar 保留（图标列）；Sidebar 收起为图标栏，hover/点击浮出；RightDock 变为触发式 Sheet；TitleBar 工作区名隐藏；StatusBar 溢出项收进更多菜单 |
| sm | 640–767px | 小窗 | 同 xs，Sidebar 浮出层更宽 |
| md | 768–1023px | 半屏窗 | Sidebar 常驻但收窄（下限 200px）；RightDock 触发式；TitleBar 工作区名截断 |
| lg | 1024–1279px | 常规桌面 | 完整布局（当前默认体验） |
| xl | ≥ 1280px | 宽屏/超宽 | 完整布局；Sidebar/RightDock 可同时展开；主区不小于最小可用宽度 |

## 布局改动验收走查清单

任何涉及布局的 PR 必须按下表逐档实机走查（`npm run tauri:dev` 拖窗改变宽度）：

| 页面/区域 | xs | sm | md | lg | xl |
|-----------|----|----|----|----|----|
| 主骨架（TitleBar/ActivityBar/Sidebar/主区/RightDock/StatusBar） | ☐ | ☐ | ☐ | ☐ | ☐ |
| 终端分屏（单终端 / 双横分 / 双竖分） | ☐ | ☐ | ☐ | ☐ | ☐ |
| 设置页（各 Section） | ☐ | ☐ | ☐ | ☐ | ☐ |
| Launcher / 命令面板 | ☐ | ☐ | ☐ | ☐ | ☐ |
| 通知中心 + Toast | ☐ | ☐ | ☐ | ☐ | ☐ |

走查结论须写进 PR 描述（逐格标注 通过/不适用/已知问题），不接受单尺寸截图。

## 实现约束

- 固定宽高仅限图标、按钮、Tab 栏等小元素；内容区一律 flex/grid/min-w-0 自适应。
- 终端 UI（TerminalView、xterm 区域、TabBar 行为）是禁改区；分屏容器只改外层壳。
- 新增 `--app-*` token 必须同步 `:root`、`.dark`、4 个 `[data-theme]` 全部六块（designTokens.test.ts 守护）。

## 实机走查记录（2026-09-05，Windows 11 + WebView2，DPI 150%）

方法：`npm run tauri:dev`，SetWindowPos 逐档设宽（xl 1400 / lg 1200 / md 1000 / sm 750 / xs 550 窗口物理像素），DevTools 实测 `innerWidth ≈ 窗口宽 − 14`（本机 WebView2 的 innerWidth 等于物理像素宽，dpr=1.5 不影响断点判定）。走查视图：panes 主视图（含真实 PowerShell 终端）+ 首页 + 设置 + 媒体生成。

| 页面/区域 | xs (536) | sm (736) | md (986) | lg (1351) | xl (1385) |
|-----------|----------|----------|----------|-----------|-----------|
| 主骨架（TitleBar/ActivityBar/主区/StatusBar） | ✅ 工作区名隐藏、仅剩关键图标 | ✅ 项目名截断 | ✅ 工作区名保留 | ✅ 完整 | ✅ 完整 |
| Sidebar | ✅ 默认收起，overlay 浮出不挤主区 | ✅ 同 xs | ✅ 浮出层 overlay、scrim 点击关闭、不遮 ActivityBar | ✅ 常驻 | ✅ 常驻 |
| RightDock | 未逐项 | 未逐项 | ✅ Sheet 右侧滑出、max-width 85vw、Close 可关 | ✅ 常驻（收起态） | ✅ 常驻（收起态） |
| StatusBar | ✅ 铃铛收进「更多工具」，行内仅主题/更多/命令面板 | ✅ 次项收进「更多工具」，菜单向上弹出内容完整 | ✅ 同 sm | ✅ 全项行内 | ✅ 全项行内 |
| 终端（xterm） | ✅ 文本清晰无糊、长行自然换行、Tab 截断正常 | 未逐项 | ✅ 字形锐利、壁纸背景下可读 | ✅ | ✅ |
| 设置页 | 未逐项 | 未逐项 | ✅ 居中大卡片无溢出；「形态」页签密度档（舒适/紧凑）切换即时生效 | 未逐项 | 未逐项 |
| 启动器/弹窗 | 未逐项 | 未逐项 | ✅ 居中弹窗宽度合适 | 未逐项 | 未逐项 |
| 媒体生成页 | 未逐项 | 未逐项 | ✅ 表单全宽自适应 | 未逐项 | 未逐项 |
| 告警 Banner（顶部） | ✅ 长文本换行不溢出 | ✅ | ✅ | ✅ | ✅ |

结论：五档降级行为全部符合断点映射表设计，无阻断问题。

### 走查发现的遗留项（非阻断）

1. **aria-hidden 焦点告警**：MainViewSwitcher 的 keep-alive 隐藏视图层（`aria-hidden=true`）内元素仍保有焦点时，浏览器报 "Blocked aria-hidden on an element because its descendant retained focus"。建议视图切换时把焦点移出被隐藏层（或改用 inert）。
2. **Radix 下拉对 AXPress 不响应**（既有现象，含「更多工具」Popover、状态栏主题菜单）：自动化/部分 AT 路径打不开，坐标点击正常；与主题卡 AXToggle 坑同族，建议后续统一评估。
3. **allotment 分屏区窄档最小宽度保护未做**（实现时评估为高风险项，xterm refit 链路敏感，见 P1-7 实现报告）。
4. xterm chunk 仍同步进首屏（123 kB gzip，panes 禁区），是 check:bundle 口径下最大剩余收益点。
