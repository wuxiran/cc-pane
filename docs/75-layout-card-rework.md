# 75 · 布局卡片改造：状态可读性 + 内容类型计数 + 新建入口补齐

## 背景

改造前的布局卡片（`web/components/layoutbar/SortableLayoutTab.tsx` 舒适档）是两行：
名称 + terminal 数、绑定标签 + 右侧 2×2 状态圆点。四个缺陷叠在一起：

1. **色盲不可辨**：2×2 四个槽位形状完全相同，危险/等授权/运行/空闲只靠颜色区分，
   冗余仅有 hover 才出的 `title`。违反 `docs/46-frontend-styleguide.md:54`
   「等待输入使用琥珀且**必须有形状或文字冗余表达**」。
2. **两套口径打架**：舒适档按 **session** 计数（`layoutStatusSummary.ts`），紧凑档按
   **pane** 聚合（`utils/layoutStatus.ts`，最多 6 个再 `+N`）。同一张卡换个密度语义就变。
3. **能力不对等**：topbar 卡片右键只有绑定+密度，**没有重命名/删除**；删除只能靠
   hover 才出现的 `×`。corner 行反而是全的。
4. **只数终端**：`contentType` 实际有 7 种，卡片上的数字只数 `terminal`，其余六类
   完全不计；而浏览器 tab 桌面端**根本没有创建入口**（只能靠 MCP `open_browser_tab`），
   `file-explorer` 也只有移动端原型能开。

## 方案

### 状态：形状 + 颜色 + 数字三重编码

`LayoutStatusGrid.tsx` 从 2×2 网格改为单行，四个桶各用**不同 svg 形状**：

| 桶 | 形状 | 色 token | 语义 |
|---|---|---|---|
| `blocked` | 实心三角 `Triangle` | `--app-status-danger` | status === error |
| `waitingInput` | 实心菱形 `Diamond` | `--app-status-warning` | 等授权 |
| `running` | 实心圆 `Circle` | `--app-accent` | thinking/toolRunning/compacting/active |
| `idle` | 空心圆 `Circle` | `--app-text-tertiary` | 真·空闲 |

- 形状用 lucide 而**不是** Unicode 字符（▲◆◉○）——字形宽度跨平台不可控。
- **零值桶不渲染**（此前留白占位），所以无告警时这一桁自然收敛成两个符号。
- `idle` 继续用中性 tertiary 而非 success：空闲是中性事实，不是好消息（styleguide :54）。
- `title` 只给状态名，计数进 `aria-label` —— 数字就在旁边，tooltip 里重复一遍是噪音。

**口径统一**：新增 `LayoutStatusRow.tsx`（自带派生的包装），紧凑档卡片与 corner
面板行都改用它，`LayoutStatusDots.tsx` 连同 pane 级聚合一起退场。
`utils/layoutStatus.ts` 保留 —— 分离窗口 `LayoutSwitcherWindow` 仍在用。

### 内容类型：七类归四桁

新增 `web/lib/tabContentType.ts`，此前 `contentType` 只是内联在 `Tab` 上的联合字面量，
既无命名类型也无任何集中映射（图标散在 TabBar、文字散在移动端原型的 `tabKindLabel`）。

| 桁 | 覆盖的 contentType | 图标 |
|---|---|---|
| 终端 | `terminal` | `Terminal` |
| 浏览器 | `browser` | `Globe2`（**不是 Globe**） |
| 文件 | `editor` + `file-explorer` | `FileText` / `FolderTree` |
| 工具 | `mcp-config` + `skill-manager` + `memory-manager` | `Settings2` |

分四桁而不是三桁，是为了让**各桁之和 === tab 总数**。卡片顶部的数字同步从
「terminal 数」改成全类型总数——顶部写 5 而下面加起来是 3，用户无从判断少的两个去哪了。

> ⚠️ **新增 contentType 时必须同步 `tabContentType.ts` 的两张表**
> （`TAB_CONTENT_GROUP` / `TAB_CONTENT_ICON`）。`tabContentType.test.ts` 用全集穷举断言
> 逼你补上——漏了会让新类型在卡片上静默不计数，且在 TabBar 上没有图标。

### 点击语义：跳转轮换，不做过滤

点「文件 3」跳到该布局第一个文件 tab，再点轮到下一个，到头回卷。

**刻意不做过滤**：过滤态会让其余 tab 从 TabBar 消失，用户第一反应是「我的终端呢」，
还得再学一个退出手势；轮换没有需要退出的状态。

游标存在组件内 `useRef`，不进 store —— 纯瞬时交互状态，进 store 只会多一份要
持久化/迁移的负担。

### 新建入口

`TabBar` 的 `+` 改为「左键新建终端（保持老手感）+ 右侧箭头展开三选一」，
拆到 `NewTabMenu.tsx`。补上桌面端此前完全缺失的**新建浏览器**与**打开目录树**。

## 两个统计规避（照抄，别自己发明）

1. **starred 布局跳过**：starred 是镜像（`panes/starredMirrors.ts`），直接统计会把同一个
   tab 数两遍。`deriveLayoutTypeSummary(tree, kind)` 收到 `"starred"` 一律返回全零。
2. **当前布局的活树在 store 工作副本 `rootPane` 上**，不在 `layouts[i].rootPane`。
   调用方必须先 `selected ? liveRootPane : layout.rootPane` 再传进来，否则当前布局的
   数字永远是旧的。

## 三个会「测试全绿但功能不生效」的坑

1. **`openEditor` 在 Files 视图下不建 pane tab**（`editorTabActions.ts:70-75`）：
   `appViewMode === "files"` 时它改走 `useEditorTabsStore.openFile()` 并返回 `null`，
   分屏区毫无反应。分屏区内的新建入口必须传 `{ forcePaneTab: true }`。
2. **不要用 `collectTerminalTabs` 做统计**：它第一步就把非终端全过滤掉了。通用遍历是
   `collectTabs`（基于 `collectPanels`），`collectTerminalTabs` 现已改写成它的特化。
3. **文件名大小写**：Windows 上 `LayoutTypeCounts.tsx` 与 `layoutTypeCounts.ts` 会被
   TS 判成同一文件（TS1149）。数据模块因此叫 `layoutTypeSummary.ts`，与
   `layoutStatusSummary.ts` 对称。

## 关键文件

| 文件 | 作用 |
|---|---|
| `web/lib/tabContentType.ts` | 七类 → 四桁归组 + 图标 + i18n key 的唯一映射表 |
| `web/lib/paneSessions.ts` | `collectTabs` / `collectTabsByContentType`（`collectTerminalTabs` 成为特化） |
| `web/components/layoutbar/layoutTypeSummary.ts` | 按四桁分桶 + 导航所需的 `paneId` |
| `web/components/layoutbar/LayoutTypeCounts.tsx` | 计数桁，单击跳转 / 再单击轮换 |
| `web/components/layoutbar/LayoutStatusGrid.tsx` | 状态桁，形状+颜色+数字三重编码 |
| `web/components/layoutbar/LayoutStatusRow.tsx` | 自带派生的状态桁（紧凑档 / corner 行） |
| `web/components/panes/NewTabMenu.tsx` | ＋ 下拉：终端 / 浏览器 / 文件 / 目录树 |
| `web/components/panes/TabTypeIcon.tsx` | 标签左侧图标位（终端出状态点，其余出类型图标） |
| `web/components/panes/useNewTabActions.ts` | 三个非终端新建入口的 handler |

## 遗留

- 紧凑档卡片不显示类型计数桁（单行放不下），只有舒适档与 corner 行有。
- corner 面板行为放下计数桁从 `w-64` 加宽到 `w-72`。
- `useEditorTabsStore`（Files 视图）与 pane 树的 editor tab 仍是**两份数据**，
  MCP `list_open_files` 是两者并集，同一文件双开会出现两条。本次未动。
