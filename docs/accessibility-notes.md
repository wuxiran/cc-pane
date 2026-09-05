# Radix 下拉/弹出组件可访问性评估与修复记录

> 范围：`web/components/ui/dropdown-menu.tsx`、`web/components/ui/context-menu.tsx`、
> `web/components/statusbar/`、`web/components/notifications/`，以及 `StatusBar.tsx`
> 「更多工具」Popover 的只读评估。
> 结论先行：**状态栏触发器的 aria 语义大多是完好的；UIA 不响应的根因不在属性缺失，
> 而在 Radix 的打开路径（pointerdown-only）与 WebView2 UIA 动作只派发 click 的交互断层。**
> 代码层可修的缺陷（缺可访问名、缺展开/选中态、键盘不可达的悬浮预览）已在本次一并修复。

## 一、背景：两条已实锤的平台现象

1. 设置页主题卡片（原生 `button + onClick`）对 Windows UIA 的 AXPress（Invoke pattern）
   **不响应**，AXToggle（Toggle pattern）**有效**；已通过补 `aria-pressed` 修复同族两处。
2. 状态栏 Radix 下拉（ThemeQuickMenu 等）与「更多工具」Popover 对 AXPress/AXToggle
   **都不响应**，坐标点击正常。

## 二、Radix 触发器实际渲染什么（源码实锤，radix-ui 1.4.3）

| 组件 | 元素 | 自动 aria | 打开路径 |
|---|---|---|---|
| `DropdownMenuTrigger` | `Primitive.button`（`type="button"`） | `aria-haspopup="menu"`、`aria-expanded`、`aria-controls`（仅 open 时）、`data-state` | **仅 `onPointerDown`（左键、无 Ctrl）**；键盘 `Enter`/`Space`/`ArrowDown`（`onKeyDown`） |
| `PopoverTrigger` | `Primitive.button`（`type="button"`） | `aria-haspopup="dialog"`、`aria-expanded`、`aria-controls`、`data-state` | `onClick` |
| `ContextMenuTrigger` | `Primitive.span`（非交互元素，无 role） | 仅 `data-state` | `onContextMenu`（右键）、触屏/笔长按 700ms |
| Menu Content（Drop/Context 共用） | `div role="menu"`，item `role="menuitem"` 等 | 由 Radix 自动管理 | Esc 关闭、方向键导航、Type-ahead、Home/End 均内建 |

关键事实：`DropdownMenuTrigger` **没有任何 onClick 处理器**（见
`node_modules/@radix-ui/react-dropdown-menu/dist/index.mjs` 中 `DropdownMenuTrigger` 实现）。
Chromium/WebView2 的无障碍默认动作（UIA `Invoke()`、AXPress、`ExpandCollapse.Expand()`）
派发的是 **`click` 事件**，不产生 `pointerdown` 序列——于是菜单不开。
坐标点击正常，因为真实指针产生完整 `pointerdown → pointerup → click` 序列。
这解释了现象 ② 中 Radix 下拉的部分：不是属性缺失，是事件路径断层。

## 三、逐触发器评估结论

### 3.1 封装层（ui/dropdown-menu.tsx、ui/context-menu.tsx）

- 两个封装均为 shadcn 风格纯透传：无自定义 `onKeyDown` 拦截、无 asChild 误用、
  无 `inert`/`pointer-events` 祖先注入。**Esc / 方向键 / Type-ahead 未被破坏**。
- `ContextMenu` 唯一自定义逻辑是开关时联动 `useBrowserWebviewOverlayStore`
  （遮挡原生 WebView），不涉及事件拦截，对键盘路径无影响。
- 缺陷（已修）：`ContextMenuTrigger` 是 span，Radix 上游不处理 Menu 键（`ContextMenu` key，
  含 Shift+F10）。filetree 在使用方自行 dispatch 合成 `contextmenu` 事件兜底；
  其它使用方没有键盘路径。已在封装层补通用 Menu 键支持——**仅当事件 target 是
  trigger 自身**（即使用方显式让 trigger 可聚焦）时生效，避免与 filetree 的
  容器级实现双重触发。

### 3.2 ThemeQuickMenu（statusbar/ThemeQuickMenu.tsx）

结构：`Tooltip > TooltipTrigger asChild > DropdownMenuTrigger asChild > button[aria-label]`。

- 双层 asChild 经 Radix Slot 逐级合并，最终 `button` 同时拿到：
  `aria-label`（显式）、`aria-haspopup="menu"`、`aria-expanded`、`type="button"`（Radix 注入）。
  **属性链完好，无丢失**（已有测试固化，见 `web/components/ui/dropdown-menu.test.tsx`）。
- UIA 不响应根因 = 第二节的 pointerdown-only 打开路径。**代码层无 aria 可补**；
  键盘用户（NVDA 焦点模式 Enter/Space/↓）可达，纯 UIA 自动化（Invoke）不可达，
  属 Radix 上游设计 + 平台交互，列入真机复核清单。

### 3.3 CommandPaletteButton（statusbar/CommandPaletteButton.tsx）

原生 `button + onClick + aria-label`，语义完好。UIA 风险与现象 ① 同族
（WebView2 Invoke 对 button 是否派发 click 存疑），代码层无缺失，不改动。

### 3.4 NotificationBellButton（statusbar/NotificationBellButton.tsx）— 已修

- **P1：无 `aria-label`**。按钮内容只有 Bell 图标 + 未读角标数字，
  可访问名退化为 "3" 这类纯数字，读屏用户完全无法理解。
- **P1：toggle 语义缺失**。按钮开关历史面板，但无 `aria-expanded`，
  UIA 不暴露 ExpandCollapse 状态（对应现象 ① 的修复模式）。
- 修复：`aria-label`（无未读复用 `center.bellTooltip`；有未读用新 key
  `center.bellLabelUnread`，如"通知中心，3 条未读"）、`aria-expanded={historyOpen}`、
  `aria-controls="notification-history-panel"`（面板根已补同名 `id`）、角标 `aria-hidden`。

### 3.5 UsageStatsStatusButton（statusbar/UsageStatsStatusButton.tsx）— 已修

- **P1：键盘不可达**。悬浮预览仅由 `onMouseEnter/onMouseLeave` 驱动，
  键盘 Tab 到按钮后没有任何办法展开预览，读屏用户同样拿不到内容。
- 修复：容器补 `onFocus/onBlur`（React 冒泡版 focusin/focusout，焦点离开整个
  容器才按既有 320ms 延时关闭，与鼠标路径一致）；按钮补 `aria-expanded={open}`、
  `aria-controls="usage-stats-hover-preview"`（预览 section 补同名 `id`）。

### 3.6 UsageStatsHoverPreview 来源筛选（statusbar/UsageStatsHoverPreview.tsx）

`DropdownMenuTrigger asChild > button`，按钮有文本内容（当前来源名）作可访问名，
haspopup/expanded 由 Radix 自动管理。**无缺失**。

### 3.7 SystemResourceSegment（statusbar/SystemResourceSegment.tsx）

`PopoverTrigger asChild > button[aria-label=resourceManagerOpen]`，
`aria-haspopup="dialog"`、`aria-expanded` 由 Radix 自动管理，onClick 链路完好。
**无缺失**。

### 3.8 SystemResourcePopover 内部折叠按钮（statusbar/SystemResourcePopover.tsx）— 已修

- 工作区分组折叠按钮：有文本名，但展开/收起 toggle **缺 `aria-expanded`** → 已补
  `aria-expanded={!collapsed}`。
- 孤立进程折叠按钮：有 `aria-label`，同样**缺 `aria-expanded`** → 已补。
- 会话行「展开进程」按钮此前已有 `aria-expanded + aria-label`，作为同文件样板保留。

### 3.9 通知历史面板（notifications/NotificationHistoryPanel.tsx）— 已修

- 过滤器按钮（全部/错误/已完成/等输入/系统）是单选式选中态，**缺 `aria-pressed`**——
  正是现象 ① 中 AXToggle 有效的修复模式，已补 `aria-pressed={filter === id}`。
- 面板根补 `id="notification-history-panel"` 供铃铛 `aria-controls` 引用。
- 「全部已读/清空/关闭」均有文本名或 IconTooltipButton 的 label，完好。

### 3.10 NotificationCard（notifications/NotificationCard.tsx）— 已修

「展开全文/收起」按钮补 `aria-expanded={expanded}`。关闭按钮经 IconTooltipButton
有 label，完好。

### 3.11 NotificationToastStack 折叠条（notifications/NotificationToastStack.tsx）

有文本名（"还有更早的通知 + 计数"），完好。

### 3.12 StatusBar.tsx「更多工具」Popover（只读评估，未改文件）

结构：`Popover > Tooltip > TooltipTrigger asChild > PopoverTrigger asChild > button[aria-label=statusbar.more]`。

- Slot 链完好：最终 button 具备 `aria-label`、`aria-haspopup="dialog"`、
  `aria-expanded`（Radix 自动）。**aria 层面无可补**。
- `PopoverTrigger` 走 `onClick`（见第二节表），UIA Invoke 派发的 click **理论上可达**，
  与 DropdownMenu 的 pointerdown-only 不同。真机不响应的候选根因，按可能性排序：
  1. **平台层**：WebView2 的 UIA Invoke/ExpandCollapse 动作对 Web 内容 button 不派发
     click——与现象 ①（原生 button+onClick 对 AXPress 不响应）一致。若真机确认，
     则该问题与设置页同源，aria 无法修复，需要平台层 workaround 或升级 WebView2 Runtime。
  2. **假阴性**：该按钮仅在视口宽度 < lg 断点时渲染（`useMediaUp("lg")` 为 false）。
     复核时若窗口较宽，按钮根本不在树上。
  3. **工具定位偏差**：自动化工具选中的是图标 svg 或外层节点而非 button 本体。
- 待办建议（供后续修改 StatusBar.tsx 的同学）：先做真机复核（见第五节清单）再决定是否
  改动；若确需代码兜底，可在该按钮上补 `onClick` 以外的 `onKeyDown` 之外、
  最小侵入的方案是给 Popover 加受控 open 并在按钮上显式 `onClick` 切换——
  但这与 Radix 的 onClick 重复，只有在确认平台层 bug 后才有意义。

## 四、修复模式小结（可复用）

1. **菜单/对话框触发器**（Radix DropdownMenu/Popover）：用 Radix 自动管理的
   `aria-haspopup`/`aria-expanded`，**不要重复手写**；封装层只负责补可访问名
   （`aria-label` 或文本内容）。
2. **自家 toggle 按钮**（开关面板/折叠/选中态）：补 `aria-expanded`（控制区域显隐）或
   `aria-pressed`（按钮自身选中态），并配 `aria-controls` 指向被控区域 `id`。
   这也是 UIA ExpandCollapse/Toggle pattern 的来源（现象 ① 的修复模式）。
3. **图标按钮**：必须有 `aria-label`；角标/装饰数字 `aria-hidden`，信息并入 label。
4. **hover-only 内容**：必须有键盘等价路径（focus 打开 / blur 关闭），触发器补
   `aria-expanded`。
5. **ContextMenu 键盘**：Menu 键/Shift+F10 由封装层在 trigger 自身聚焦时合成
   `contextmenu` 事件打开；使用方已有容器级实现（如 filetree）时不重复触发。
6. **双层 asChild**（TooltipTrigger > DropdownMenuTrigger > button）：Slot 合并可靠，
   属性不丢；保持 trigger 为链条内层、真实元素最内即可。

## 五、Windows 真机 NVDA / UIA 验证清单（jsdom 覆盖不了的维度）

环境：Windows 主机 + 应用 release 或 dev 构建 + NVDA 最新版 + Accessibility Insights
（或 FlaUI/pywinauto）。

- [ ] NVDA 焦点模式：Tab 到状态栏各触发器，确认朗读名称（主题菜单/通知中心含未读数/
      命令面板/资源管理器/更多工具）。
- [ ] NVDA 焦点模式 Enter/Space/↓ 打开 ThemeQuickMenu，方向键遍历预设，Enter 选中，
      Esc 关闭并回到触发器。
- [ ] NVDA 浏览模式与焦点模式分别验证通知铃铛：`aria-expanded` 状态被朗读
      （"已展开/已折叠"），未读数并入名称。
- [ ] 键盘 Tab 到用量统计按钮：焦点进入即展开预览，继续 Tab 进入预览内的来源筛选
      下拉与「更多」链接，Shift+Tab 离开后预览按延时关闭。
- [ ] Accessibility Insights：检查「更多工具」按钮在 UIA 树的 ControlType=Button、
      支持的 pattern（Invoke、ExpandCollapse）；对其分别调用 `Invoke()` 与
      `Expand()`，观察 Popover 是否打开——以此裁决第 3.12 节的候选根因 1/2/3。
- [ ] 同法对 ThemeQuickMenu 触发器调用 `Invoke()`：预期仍不打开（pointerdown-only），
      用键盘路径替代；记录结果以备 Radix 上游升级后复测。
- [ ] 窗口宽度调到 < lg 与 ≥ lg 两档各复核一次「更多工具」入口存在性（排除假阴性）。
- [ ] Shift+F10 / Menu 键：在 filetree 行上与（未来）显式可聚焦的 ContextMenuTrigger
      上分别验证菜单打开于正确位置、不双开。
- [ ] 系统资源 Popover 内：分组折叠、孤立进程折叠朗读展开状态；
      通知历史面板过滤器朗读"已按下/未按下"。

## 六、本次改动文件清单

- `web/components/ui/context-menu.tsx` — ContextMenuTrigger 补 Menu 键/Shift+F10 打开路径。
- `web/components/statusbar/NotificationBellButton.tsx` — aria-label/expanded/controls + 角标 aria-hidden。
- `web/components/statusbar/UsageStatsStatusButton.tsx` — 键盘 focus 打开路径 + aria-expanded/controls。
- `web/components/statusbar/UsageStatsHoverPreview.tsx` — 预览 section 补 `id`。
- `web/components/statusbar/SystemResourcePopover.tsx` — 分组/孤立进程折叠按钮补 aria-expanded。
- `web/components/notifications/NotificationHistoryPanel.tsx` — 过滤器 aria-pressed + 面板 id。
- `web/components/notifications/NotificationCard.tsx` — 展开/收起 aria-expanded。
- `web/i18n/locales/zh-CN/notifications.json`、`web/i18n/locales/en/notifications.json` — 新增 `center.bellLabelUnread`。
- 测试：`web/components/ui/dropdown-menu.test.tsx`（新建）、
  `web/components/ui/context-menu.test.tsx`（追加）、
  `web/components/statusbar/NotificationBellButton.test.tsx`（新建）、
  `web/components/statusbar/a11y.test.tsx`（新建）、
  `web/components/notifications/NotificationHistoryPanel.test.tsx`（新建）。
