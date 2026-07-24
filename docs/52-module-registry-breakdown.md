# 52. 模块注册表拆分分析（P1-6a 前置整理，rev.2 全量普查版）

> 2026-07-24。docs/45 P1-6 的"模块注册表 + 右坞"拍板前的现状盘点与拆分方案。rev.2：按全应用 UI 功能面普查（135 个功能单元 / 14 个位面）重定拆分结论。方向性文档：结论经用户拍板后抽独立 plan 实施。

## 1. 全量普查结论（2026-07-24 实扫 web/）

全应用用户可见功能单元约 **135 个**，分布：

| 位面 | 数量 | 代表 |
|---|---|---|
| 独立窗口（URL mode 分流） | 7 | 主窗 / 弹出终端 / 布局切换器 / ccchan / 移动原型 / WebGL 诊断台 |
| AppShell 骨架件 | 13 | TitleBar / StatusBar / 壁纸层 / Toast / 迷你模式 / 鉴权门 / 引导 |
| ActivityBar 入口 | 8（+3 禁用） | Home / Explorer / SSH / 编排 / 资源中心 / Todo / 设置 |
| 全屏视图（appViewMode） | 11 | home / todo / selfchat / providers / resources / files / panes / starred… |
| 侧栏视图 + Explorer 内部 section | 12 | 工作区树 / 文件 / Git / 最近启动 / SSH / 编排 / 环境面板 |
| StatusBar segment | 12 | 工作空间名 / 终端数 / 更新 / 音乐 / 置顶 / 迷你 / ccchan / 语言 / 主题… |
| 全局 Dialog（useDialogStore） | 10 | Journal / LocalHistory / GitTimeline / SessionCleaner / Todo / Plans / SelfChat… |
| Tab 内容类型 | 6（+5 附属） | 终端 / 编辑器 / 文件浏览 / **项目MCP / Skill管理 / Memory管理** |
| Home 卡片 | 10 | 快捷动作 / 用量 / 最近项目 / 活跃会话 / 环境概览… |
| ResourceHub 分区 | 3 | Provider / 全局 Skills / 共享 MCP |
| Settings section | 14 | general…about |
| ccchan 内部 / 编排子面板 / 其他 | ~29 | 宠物精灵 / 任务树 / 编辑器套件 / Worktree 管理 / 迁移弹窗… |

**关键架构发现**：应用已存在 **4 个事实上的"挂载中枢"**——`MainViewSwitcher.tsx`（appViewMode 总线）、`AppDialogs.tsx`（Dialog 总线）、`ActivityBar.tsx`（入口总线）、`TabContentRenderer.tsx`（tab 类型总线）。任何功能单元都在这四处之一挂载。**模块注册表的本质 = 给这四条总线一张统一的声明表**，而不是新发明一个位面。因此 schema 的 surface 枚举必须是五值：`rightDock(新) | dialog | fullscreen | tab | window`。

## 2. 全量分类：135 个单元收敛为四类

**① 系统骨架（~35 个，不进注册表）**：AppShell 五区、TitleBar、StatusBar 框架、Toast、ErrorBoundary、WebAuthGate、壁纸/背景、迷你模式、无边框按钮、CommandPalette、Launcher、RecentFilesPicker、Onboarding、布局系统（LayoutBar/切换窗）、各动作类弹窗（GitClone/ScanImport/迁移/绑定/导入确认等——**动作不是模块**）。

**② 导航（~8 个，左栏保留，不进注册表）**：Home、Explorer（工作区树 + 文件/Git/最近启动 section）、设置入口。

**③ 产品引擎（2 个，不进注册表）**：终端分屏引擎（panes/）、文件编辑器套件（editor/）——它们是 tab 内容的本体，是产品本身而非"工具模块"。

**④ 工具模块（注册表对象，v1 = 16 个）**：见 §4。

**另有三个"同构但独立的槽位体系"，v1 不收编、留同款模式后做**：Home 卡片（10）、StatusBar segment（12，Orca 右键勾选段先例）、Settings section（14）。它们各自内部已是"列表渲染"，将来可各配一张小注册表（卡片可配置/状态栏段可勾选），但和右坞模块是不同槽位，硬并进一张表只会做成四不像。

## 3. 模块注册表 schema（rev.2）

```ts
interface ModuleDef {
  id: string;
  icon: LucideIcon;
  titleKey: string;
  scope: "app" | "workspace" | "project" | "session";
  surfaces: Array<"rightDock" | "dialog" | "fullscreen" | "tab" | "window">;
  defaultSurface: ModuleSurface | "hidden";
  badge?: BadgeSource;
  experimental?: boolean;
  onboardingKey?: string;
}
```

## 4. 工具模块清单 v1（16 个）

| # | 模块 | 现居 surface | scope | v1 surfaces | 备注 |
|---|---|---|---|---|---|
| 1 | SSH 机器 | 侧栏视图 | app | rightDock+dialog | 首迁批 |
| 2 | 编排 | overlay+侧栏 | workspace | fullscreen(overlay 保持) | v1 只收编入口 |
| 3 | Todo | 全屏+Dialog | 可变 | fullscreen+dialog+rightDock | 三形态首例 |
| 4 | Journal | Dialog | workspace | rightDock+dialog | 首迁批 |
| 5 | Plans | Dialog | project | rightDock+dialog | 首迁批 |
| 6 | Local History | Dialog | project | dialog（diff 宽度） | dock 形态 0.11.2+ |
| 7 | Git 时间线 | Dialog | project | dialog（同上） | |
| 8 | SessionCleaner | Dialog | project | rightDock+dialog | |
| 9 | SelfChat | 全屏+Dialog | session | rightDock+dialog+fullscreen | |
| 10 | 会话历史（新） | — | 可变 | rightDock | P1-6b，首个新住户 |
| 11 | Worktree 管理 | Dialog/面板 | project | rightDock+dialog | 普查新发现，天然列表型 |
| 12 | Memory 管理 | **tab** | project | tab+rightDock | tab 形态已存在 |
| 13 | Skill 管理 | **tab** | project | tab+rightDock | 同上 |
| 14 | 项目 MCP 配置 | **tab** | project | tab | |
| 15 | ccchan | 独立窗口 | app | window（技术红线） | 仅列名+开关 |
| 16 | 进程监控 | 已禁用 | app | rightDock, `experimental` | 借实验区复活（macOS 卡顿史,默认关） |

资源中心（Provider/Skills/共享 MCP 三合一）v1 暂缓收编——体量大且是 app 级管理页，等注册表稳定后二批。

## 5. 核心难点（不变，rev.2 补充）

### 5.1 上下文注入——最大设计决策
Dialog 靠显式传参；右坞常驻面板需要"活跃上下文"派生 store（活跃 pane → 会话 → project/workspace）+ pin 固定模式 + 空态回落。scope 四类（含 session 级：SelfChat）。这是 6a-1 的真正地基。

### 5.2 双形态复用——逐模块判定（§4 表已判）

### 5.3 五形态并存——注册表承认现实
fullscreen（todo/resources）与 tab（memory/skill/mcp）都是既存形态，收编≠强迁形态。v1 只做"注册表统一声明 + 右坞新位面 + 入口收编"，不搬迁任何运转良好的形态。

## 6. 实施分批（对应独立 plan）

| 批 | 内容 | 预估 |
|---|---|---|
| 6a-1 | `useActiveContextStore` + 注册表 schema + RightDock 宿主（窄图标条+内容区+宽度持久化+折叠） | 2d |
| 6a-2 | 首迁 3 个：Journal(workspace)/Plans(project)/SSH(app)——列表型，scope 三谱验证；左栏旧入口兼容跳转 | 1.5d |
| 6a-3 | 二迁：Todo/SessionCleaner/SelfChat/Worktree；编排/记忆/Skill 入口收编；设置页"模块"区 + 图标条右键勾选 | 2d |
| 6b | 会话历史面板（规格见 docs/45 P1-6） | 2-3d |
| 二批(0.11.2+) | LocalHistory/GitTimeline dock 形态、资源中心收编、CommandPalette 动作源接线、引导卡、Home 卡片/StatusBar 段/Settings 的同构小注册表 | — |

## 7. 拆干净的判据（2026-07-24 用户定调："不同的人用的功能不一样，要拆干净"）

**唯一硬判据：模块可整体关闭且无残留。** 模块 `enabled=false` 时必须同时满足四条：

1. **入口消失**：四条总线（ActivityBar/右坞图标条/Dialog 总线/tab 类型）上都不渲染该模块的任何入口与菜单项；CommandPalette 动作同步消失。
2. **组件不挂载**：模块组件走 `lazy()` 动态 import，关闭时不进执行路径（bundle 分包顺带达成）。
3. **后台零开销**：徽章数据源是**声明式懒订阅**（模块启用才 subscribe）；模块关联的轮询/watcher/事件监听一并不起。**这条要下沉到 Rust 侧**——有后端资源的模块（Local History 的 watcher、进程监控的采样）开关须传导为后端门禁（`HistoryWatchManager` 惰性化已是正面范例；docs/41 的 129 线程事故就是反面教材：功能"藏起来"但没关干净）。
4. **互不引用**：模块间禁止直接 import；跨模块跳转只走注册表 API `openModule(id, ctx)`（弱依赖：目标模块被关时降级为"提示启用"而不是报错）。模块只允许依赖平台层（stores/services/ui/i18n/上下文 store）。

**配套护栏（机器化，延续 P1-1 思路）**：vitest 静态测试断言 `web/modules/`（或注册表清单内的模块目录）之间零交叉 import——拆分质量不靠自觉靠测试。

**平台层定义（模块可以依赖的公共地基）**：终端引擎(panes)、编辑器(editor)、导航（Home/Explorer/设置）、启动器、活跃上下文 store、注册表本身、ui/ 基件、i18n、services 层。平台层不可被"关闭"。

## 8. 角色预设（模块化的产品化出口）

**两档模式（2026-07-24 用户拍板，不做多角色矩阵）**：

| 模式 | 画像 | 内容 |
|---|---|---|
| **全功能模式** | 现状体验 | 16 模块全启用（experimental 仍默认关） |
| **极简模式** | **不一定是开发者**——写作/研究/办公等任何拿 AI CLI 干活的人，只要干净的多开终端和会话管理，看不懂也不想看到工程功能 | **零模块**（纯平台层：终端引擎/项目管理/编辑器/启动器/设置）；**skills 也给最少**——极简不只是 UI 收纳：随附的 ccpanes skills/内置工具面同步收敛到最小集（basic launch/workspace 级），MCP 工具面走延迟加载天然配合，重型 skill（编排/parallel/fanout 系）不随极简预设分发。**文案约束**：极简档可见的 UI 文案不得预设工程语境（"仓库/分支/worktree"等词只在相关模块开启后出现） |

首启引导一个二选一开关（默认全功能）；设置页"模块"区随时逐项改，模式只是初值不是锁定。约定：①现有用户升级**不套预设**——按"当前实际可见功能全启用"生成配置，零感知；②改动任一模块开关即为自定义态，两档只是两个出厂快照；③新增模块声明"极简档是否包含"一个布尔即可（不做多角色矩阵——两档之下矩阵退化为一列）。

## 9. 待用户拍板

1. ~~上下文跟随策略~~ **已拍板（2026-07-24 实机反馈）**：跟随激活终端所属 workspace/project（"最后动作优先"，不强制）；pin 固定模式留 6a。首块实现见 `.claude/plans/0111-context-follow.md`（排队中）。
2. **编排**：v1 保持 overlay 只收编入口（本文建议），还是降为右坞普通面板？
3. **Local History / Git 时间线**：v1 dialog-only（本文建议）还是做"坞内列表+弹出 diff"？
4. **范围**：6a-1+6a-2 进 0.11.1 验证架构，6a-3/6b 滑 0.11.2（本文建议）；还是四批全进？角色预设与首启引导建议放 6b 之后独立一批（依赖模块开关机制稳定）。
5. **进程监控复活**（#16）：要不要借实验区机制回归？（macOS 卡顿史在案，默认关+实验标）
6. ~~角色集合~~ **已拍板（2026-07-24）**：两档——全功能模式 / 极简模式（零模块 + skills 最小集；极简用户**不一定是开发者**），不做多角色矩阵。
7. **物理目录重组**：是否把 16 个模块的组件逐步归拢到 `web/modules/<id>/`（配零交叉 import 护栏）？可以只对新模块生效、存量渐进迁移。
