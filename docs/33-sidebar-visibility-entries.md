# 侧栏可见性入口：标题栏折叠开关 + 首页「进入工作区」前置

> 状态：待实施 | 基线：工作树内有九个 worker 的未提交改动，**不要动它们**

## ⚠️ 约束

**只许碰**：

- `web/components/TitleBar.tsx`（任务 1）
- `web/components/home/HomeDashboard.tsx`（任务 2）
- i18n：`web/i18n/locales/{zh-CN,en}/` 下 `common.json` / `sidebar.json` / `home.json`
- 对应 `*.test.tsx`

**不要碰**：`web/stores/useActivityBarStore.ts`（机制已完备，只需消费）、
`web/components/layout/`、`web/components/sidebar/`、`web/components/panes/`、
`web/components/launcher/`、`web/components/providers/`、
`web/hooks/useShortcutRegistrations.ts`。
**禁止任何 git 写操作**（工作树里有九个 worker 的未提交成果）。

## 共同前提：状态机制已存在，不要新增状态

- `useActivityBarStore.ts:9` `sidebarVisible: boolean`
- `useActivityBarStore.ts:75` `setSidebarVisible(visible)`
- `useActivityBarStore.ts:77` `toggleSidebar()`
- 消费方 `web/components/layout/MainViewSwitcher.tsx:33`

目前唯一切换方式是**再点一次已激活的 ActivityBar 图标**（`useActivityBarStore.ts:68`）
——能用但完全不可发现。本任务只加入口，不改状态层。

---

## 任务 1：标题栏折叠开关

位置：标题栏左侧，应用名 `CC-Panes ▾` 下拉的右侧。

- 图标：lucide `PanelLeft` / `PanelLeftClose`（或 `PanelLeftOpen`），
  按 `sidebarVisible` 切换图标，让当前状态一眼可辨
- 组件：**必须用 `ui/IconTooltipButton`**
  （`docs/22-frontend-design-refactor.md` §5 禁用原生 `title=`），
  tooltip 区分「隐藏侧栏」/「显示侧栏」
- `strokeWidth={1.5}`；样式走 token，禁止 `style={{}}` 硬编码色；文案走 i18n
- 行为：调 `toggleSidebar()`

### ⚠️ 平台坑（动手前必读）

`TitleBar.tsx:26-31` 有详细注释：Linux/WebKitGTK 会吞掉 `-webkit-app-region` 拖拽区
内的点击。**新按钮必须显式设 `-webkit-app-region: no-drag`**，否则部分平台点不动。

### 快捷键（本次不做）

`Ctrl+B`（VS Code 惯例）需要改 `useShortcutRegistrations.ts`，
**该文件不在可改范围内**。若你认为值得加，在汇报里提出，由 leader 另派。

---

## 任务 2：「进入工作区」前置并放大

**现状**：`HomeDashboard.tsx:139-153`，按钮在**整个首页的最底部**居中放置，
用户要一路滚到底才能看见——这是首页最主要的行动召唤，位置完全不对。

```tsx
{/* 进入工作区按钮 */}
<div className="flex justify-center pt-2 pb-2">
  <button className="... px-8 py-3 rounded-xl text-sm font-semibold ..."
    onClick={() => setAppViewMode("panes")}>
    {t("enterWorkspace")}
    <ArrowRight className="w-4 h-4" />
  </button>
</div>
```

**改动**：

1. **移动位置**：挪到首页顶部问候区（「晚上好 / 欢迎回来 — CC-Panes」那一块）
   的**右侧空白区域**——当前那片区域是空的。
   与问候语同一行、右对齐，或紧随其后成为该区块的主行动按钮。
   原底部的那份**删掉**，不要两处都留。
2. **放大**：比现在的 `px-8 py-3 text-sm` 更大更醒目——
   它是首页的主 CTA。保留现有的 accent 渐变风格（`:144-147` 已用 token，可沿用），
   适当加大内边距与字号，图标同步放大。
3. **点击后展开左侧面板**：当前只有 `setAppViewMode("panes")`，
   需**同时** `setSidebarVisible(true)`，让用户进入工作区后左侧面板是展开的。

### 布局注意

问候区右侧区域在窄窗口下可能没有足够空间——需保证响应式：
窄屏时按钮换行或缩小，不得把问候语挤变形、不得让页面横向滚动
（`docs/22-frontend-design-refactor.md` 的响应式约定）。

---

## 验收

- `npx tsc --noEmit`
- `npx vitest run web/components/TitleBar.test.tsx web/components/home/ --maxWorkers=2` 全绿
- 补测试：
  - 标题栏按钮点击调用 `toggleSidebar`；图标随 `sidebarVisible` 切换
  - 「进入工作区」点击同时触发 `setAppViewMode("panes")` 与 `setSidebarVisible(true)`
  - 首页底部不再有重复的「进入工作区」按钮
- 手动：标题栏按钮能收起/展开左侧面板且不影响窗口拖拽；
  首页顶部能看到大号「进入工作区」，点击后进入分屏视图且左侧面板已展开；
  窄窗口下顶部布局不塌
