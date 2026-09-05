# 分屏窄档（< md）保护：refit 风险评审与实施记录

> 关联：docs/responsive-breakpoints.md 走查遗留项 3（"allotment 分屏区窄档最小宽度保护未做，
> 实现时评估为高风险项，xterm refit 链路敏感"）。本文先给出评审结论，再记录实施点与验证结果。

## 0. 事实校正

- 任务口径称"分屏容器 allotment@1.20.5（SplitContainer/SplitView 封装）"。实际代码中
  `allotment` 仅存在于 `package.json` 依赖声明（^1.20.5），`web/` 下无任何 import；
  `web/components/panes/SplitView.tsx` 是**自研 flex 实现**（pointer 拖拽直接改
  `flexBasis`），`SplitContainer` 只是它的薄封装。因此"allotment 最小列宽"在本仓库
  的真实答案是：**没有 allotment；有效列宽下限 = SplitContainer 传入的 `minSize=50px`
  （仅拖拽钳制），CSS 无任何布局层下限，sash 固定 3px**。
- 窄档坏表现与该钳制无关布局：拖拽被钳在 50px，但窗口变窄时 `flexBasis: %` 仍会把
  每列压到任意小——50px 是"拖得到的最小值"，不是"布局保得住的最小值"。

## 1. 尺寸链路（评审对象）

### 1.1 拖拽/布局 → xterm fit 的完整链路

```
SplitView sash pointerdown/move
  └─ rAF 内直接改 panes[i].style.flexBasis（不经 React，避免重渲染）
       └─ [data-splitview-pane] 盒尺寸变化
            └─ TerminalView 内 .cc-terminal-host 的 ResizeObserver
               （useTerminalInstanceInit.ts: observer.observe(terminalRef.current)）
                 ├─ isDragging() === true：80ms 节流 flush("resize-observer.drag.fit")
                 │    + DRAG_CONTAINER_CHANGE=20px 增量门（terminalResizeObserver.ts）
                 └─ 平时：150ms 防抖 schedule("resize-observer.fit")
                      + MIN_CONTAINER_CHANGE=5px 增量门
                       └─ terminalLayoutScheduler.applyLayout
                            ├─ isTerminalHostRenderable 门（display:none/0 尺寸跳过，记 pendingReason）
                            ├─ fitAddon.fit() → repaint
                            ├─ cols/rows 变化才 scheduleBackendResize（250ms 去抖，leading+trailing）
                            └─ verify.refit：120ms 后 proposeDimensions 复核，不一致强制补 fit，
                               上限 VERIFY_REFIT_MAX_ATTEMPTS=3（防嵌套分屏二次 reflow 卡旧尺寸）
pointerup → onDragEnd → store.resizePanes → notifyTerminalLayoutChanged
  └─ TERMINAL_LAYOUT_CHANGED_EVENT（rAF 派发）
       └─ useTerminalLayoutEvents：schedule("layout-change.*", { force, allowInactive })
```

### 1.2 keep-alive 隐藏时舞台尺寸如何保持

- 主视图层：`.main-view-layer` 全部 `absolute inset-0` 共占同一舞台盒，切换只 cross-fade
  透明度（index.css `.main-view-layer`，`opacity var(--dur)`），盒尺寸恒定。
- 面板内标签：Panel.tsx 对所有 tab 保持挂载，非活动 tab `display:none`。此时
  `isTerminalHostRenderable` 返回 false → fit 被跳过并记 `pendingReason`；RO 仍观察
  （`allowInactive:true`），容器若真实变化会留下挂起请求；标签翻回可见时
  `useViewVisibilityEdgeSubscription` → `restoreVisibleTerminalView`（补投积压 + 调度 refit）。
  即"隐藏不 fit、回来补 fit"，内容靠 hiddenWriteBuffer 不丢。

### 1.3 TerminalZoomHud / 缩放与容器宽的关系

- Ctrl+滚轮缩放只改 `fontSize`（useTerminalWheelZoom）→ useTerminalAppearanceSync 写
  `term.options.fontSize` 并 `schedule("settings.terminal-appearance", { force })` → fit。
  该链路**不读容器宽**，与分屏宽度解耦；HUD 是 `absolute` 居中浮层，不参与布局。
  结论：窄档改动只要不动字号链路，就与缩放/HUD 零交互。

## 2. 窄档真实坏表现（评审回答）

| 场景 | 实测推算（默认字号 15px，cell ≈ 9px 宽） | 表现 |
|------|------------------------------------------|------|
| 双横分 @ innerWidth 700（sm 上沿，主区 ≈ 620px） | 每列 ≈ 308px ≈ 34 cols | Claude Code TUI 边框/状态栏折行错位，长行硬换行后不可读 |
| 双横分 @ innerWidth 500（xs，主区 ≈ 420px） | 每列 ≈ 208px ≈ 23 cols | TUI 基本不可用；拖拽还可把一列压到 50px ≈ 5 cols，完全糊死 |
| 双竖分 @ < md | 每行全宽，列宽不受影响 | 宽度方向无窄档特有问题；高度被均分是既有行为，非本任务范畴 |
| keep-alive 隐藏 tab | 舞台盒恒定 | 无直接坏表现；风险只在"方案若改舞台/挂载方式"时引入 |

## 3. 备选方案对比与 refit 风险评估

| 方案 | 做法 | refit 次数（跨断点一次） | keep-alive | lg+ 影响 | 结论 |
|------|------|--------------------------|------------|----------|------|
| A. 窄档列宽下限 + 容器横向滚动 | < md 且横向分屏：pane `min-width: 320px`，`.split-container` `overflow-x:auto` | 离散 1 次（min-width 生效/失效各一次 RO 回调，150ms 防抖合并为 1 次 fit + 至多 1 次 verify）；160ms transition 期间的中间帧被 `cancel()`+防抖合并，且有 5px 增量门 | 不破坏：只动外层壳盒尺寸，tab 仍全挂载，隐藏 tab 走既有 pending/补 fit | 零：下限与 overflow 均条件挂载 | **采纳** |
| B. 窄档强制单格聚焦（其余折叠为切换条） | 条件渲染 active pane，兄弟折叠 | 折叠若不卸载则其盒变 0 → 每个被折叠终端 1 次 0 尺寸 RO（被 renderable 门挡住）+ 展开时再 fit；若卸载则触发 TerminalView 重建——正是 SplitView 注释明确规避的"UI 假死"路径 | **高风险**：折叠语义与"隐藏仍收输出"模型冲突，需重写可见性/焦点 | 零 | 否决：改动面大、触碰 keep-alive 心智模型 |
| C. 仅加大列宽下限（不加滚动） | minSize 50→320 | 0 次新增 | 不破坏 | 拖拽钳制变化 | 否决：容器 < 2×320+3 时下限物理上无法满足，`flexBasis:%` 依旧把列压小，不解决可读性 |

### 方案 A 的 refit 安全性论证（对应硬验收 2）

1. **RO 唯一性**：全树唯一 ResizeObserver 在 TerminalView 的 xterm host 上
   （terminalResizeObserver.ts）。本次改动只在 SplitContainer/SplitView 增条件样式，
   **不新增任何观察者与回写**（测试断言 ResizeObserver 构造次数为 0），不存在
   "观察→改样式→再观察"的自激回路。
2. **离散性**：min-width/overflow 只在断点穿越瞬间变化一次，等价于一次窗口 resize；
   既有 5px 增量门 + 150ms 防抖 + verify 上限 3 保证收敛，无持续 reflow 源。
3. **滚动条副作用有界**：横滚动条出现会让 `.split-container` 内容高少 ~12px →
   各 pane 高度变化一次 → 每终端至多 1 次防抖后 fit。`overflow-y:hidden` 同步设置，
   排除纵滚动条往返振荡。
4. **隐藏 tab**：盒变小/归零 → renderable 门跳过并记 pending；翻回可见时补 fit。
   内容缓冲（hiddenWriteBuffer）与序列化恢复均不依赖容器宽，**不丢不糊**（硬验收 1）。
5. **lg+ 零变化**：条件样式仅在 `bp < md` 挂载；lg/xl 渲染输出与现状逐字节一致
   （拖拽、钳制、flexBasis、事件全不变，测试逐项回归）。

## 4. 实施点（2026-09-05）

- `web/components/panes/SplitView.tsx`
  - 新增可选 prop `paneMinWidth?: number`。设置时每个 `data-splitview-pane` 的
    `minWidth` 从 `0` 变为 `${paneMinWidth}px`，并挂 `transition: min-width var(--dur)
    var(--ease-out)`（lg+ 未传该 prop 时 minWidth 仍为 0、无 transition，零行为变化）。
  - 未传 prop 的渲染路径与旧版逐行等价；拖拽数学（minSize 百分比钳制）完全未动。
- `web/components/panes/SplitContainer.tsx`
  - `useBreakpoint()` 取档；`narrow = BREAKPOINT_ORDER.indexOf(bp) < indexOf("md")`
    （breakpoints.ts 为唯一事实源，md 以下 = xs/sm 生效，lg 以上零变化）。
  - 仅当 `narrow && pane.direction === "horizontal"`：传
    `paneMinWidth = 320`（`NARROW_PANE_MIN_WIDTH_PX`，≈35 cols 可读下限），
    外壳 `.split-container` 加 `overflowX:"auto" + overflowY:"hidden"`。
  - 竖向分屏窄档不加任何处理（每行全宽，本就可读）。

## 5. 测试（web/components/panes/ 就近）

- `SplitContainer.test.tsx`：xs/sm/md/lg/xl 五档 props 断言（innerWidth + resize 事件）；
  横向窄档传 paneMinWidth + 外壳 overflow；竖向窄档不传；lg+ 无 paneMinWidth、无 overflow；
  **refit 不循环**：mock ResizeObserver 计数为 0（分屏组件不自观察）+ MutationObserver
  统计断点穿越后 style 变更收敛、重复同档 resize 事件幂等（0 次新变更）。
- `SplitView.test.tsx`：paneMinWidth 落 minWidth/transition；未传时 minWidth=0（旧行为）；
  带 paneMinWidth 拖拽仍按旧百分比钳制上报。

## 6. 已知边界与后续项

- `TerminalTabContent.tsx`（标签内终端叶子分屏）也直接消费 `SplitView`，本次未传
  `paneMinWidth`（该文件不在本任务改动范围），其嵌套分屏在窄档保持旧行为。
  `paneMinWidth` 为可选 prop、默认 0 下限，旧调用点零影响；如需覆盖可后续单独评审接入。
- 窄档下限生效期间，拖拽仍按"可见宽百分比"数学工作，渲染宽度由 min-width 兜底，
  store 中百分比与可视列宽可能短暂解耦（与 lg 宽档行为无冲突，升档即恢复一致）。

## 7. Windows 真机验证清单（本任务不在 Windows 主机执行，须补走查）

- [ ] xs（~500px）双横分：两列均 ≥320px、可读，横向滚动条出现且可拖；终端内容不糊。
- [ ] xs↔lg 反复拖窗跨档：终端不重排循环、无持续重绘（任务管理器 CPU 不飙）。
- [ ] 窄档下切换 tab / 切工作区（keep-alive 层）：回来内容完整、不错位。
- [ ] 窄档横向滚动后拖 sash：拖拽仍按可见宽百分比工作，无跳变。
- [ ] lg/xl 双分屏拖拽：与改动前逐项一致（手感、钳制 50px、onDragEnd 百分比）。
- [ ] WebView2 横滚动条高度导致的终端高度一次性 refit 肉眼无感。
