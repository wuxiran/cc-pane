# 53. 设置页改版（参考 Orca）——需求分析与吸收清单

> 2026-07-24 用户提需："设置页面要进行改版，参考鲸鱼（Orca）的，看看我们是不是也需要他的那些设置功能"。基于 Orca 源码快照只读研究（`../references/orca`，细节证据见本文引用路径）。方向性文档：吸收清单经用户勾选后抽独立 plan。

## 1. Orca 设置系统的五个可复用机制（架构层，全部建议吸收）

| # | 机制 | Orca 实现 | 对 CC-Panes 的意义 |
|---|---|---|---|
| M1 | **单一注册表驱动侧栏+命令面板** | `useSettingsNavigationMetadata.ts` 唯一 pane 清单，Settings 侧栏与 Cmd+J 共享，配架构测试锁边界 | 正是 docs/45 P1-2 的完全体；且与 docs/52 模块注册表同构——"注册表驱动一切"是同一设计语言 |
| M2 | **搜索索引与 pane 声明同源 + 分层打分** | 每 pane 一个 `*-search.ts`（59 个），条目 `{title,description,keywords,targetSectionId}`；打分 pane 标题 900 > 条目 700 > 描述 500 > 关键词 300；输入/应用双查询 150ms 防抖 | P1-2 的实现规格直接照此做，防漂移（数字从注册表生成） |
| M3 | **懒挂载**：一次只挂载激活 pane，非激活 `return null` | `Settings.tsx` mountedSectionIds | 我们 13-14 个 Section 目前全挂载；改版顺手拿下 |
| M4 | **控件级搜索过滤 + 深链锚点** | `SearchableSetting.tsx` 不匹配不渲染；`data-settings-section` + 双 rAF 滚动兜底（懒挂载迟到） | 搜索直达具体控件而不只是 pane |
| M5 | **实验特性毕业三件套** | 持久化层 `新字段 ?? 旧experimental ?? default` 水合 + `*DefaultedForAllUsers` 幂等标记 + 删 UI/搜索条目；成文迁移设计文档 | **与 docs/52 实验模块毕业是同一机制**——一次实现两处复用 |

另：Orca 的表单 house style（`docs/STYLEGUIDE.md`：space-y 密度分级 / label 组 / 尾部元数据 11px / 按钮变体优先级 / 单色安静风）与我们 docs/46 高度同源，可摘 2-3 条补进 docs/46 表单小节（如"尾部元数据放控件下方不放 label 旁"、"Cancel 绝不用 destructive"）。

## 2. 功能面逐项对比：Orca 有而我们没有的，要不要？

**已对等（不用动）**：agents/accounts ≈ 我们 Provider+CLI 启动器；voice 已有；ssh 已有；shortcuts 已有；notifications 已有；terminal 已有；appearance ≈ 通用+壁纸+主题；mobile ≈ cc-panes-mobile（形态不同）。

**建议吸收（候选，待勾选）**：

| # | Orca 功能 | 说明 | 我方现状 | 建议 |
|---|---|---|---|---|
| F1 | **Repositories 动态 per-project pane** | 每个项目一个设置行（仓库级设置：身份/hooks/worktree/作者） | 项目级配置存在（`.ccpanes/config.toml`）但**设置页无入口**，散在右键/对话框 | **吸收**——与 docs/52 项目 scope 概念契合，动态 pane 机制顺手覆盖 |
| F2 | **Experimental pane + 毕业机制** | 实验区 + 毕业迁移 + 隐藏 power-user 组（Shift 点击解锁） | 无 | **吸收**——docs/52 模块化已拍板需要实验区，同一机制 |
| F3 | **Git & Source Control pane** | 分支命名规则、base ref、Git AI author、commit message AI | Git 功能强但**零设置面**（全是默认行为） | 酌情——先只建 pane 壳收纳未来 git 设置，AI author 类功能另议 |
| F4 | **Setup guide（onboarding checklist pane）** | 核心工作流引导清单常驻设置 | OnboardingGuide 一次性 | 酌情——与 P2 引导体系联动，可后置 |
| F5 | **Stats & Usage pane** | token 分析/订阅用量 | Home 有用量卡片 | 暂缓——docs/45 已裁"扩展现有 StatusBar，勿新建位面" |
| F6 | **Advanced 排障 pane** | 底层兼容开关集中地 | 散/无 | 酌情——有排障开关需求时再建壳 |

**明确不吸收**：computer-use（不做）、tasks sources/看板集成（docs/45 已裁不做）、privacy/telemetry（我们无遥测，是本地优先卖点不是缺口）、browser pane（P2 spike 后随浏览器 tab 一起来）、mobile-emulator（无场景）、Linear（不做）。

## 3. 改版方案（分两批抽 plan）

**批 1：视觉 + 架构改版（~4-5d，视觉是主体，架构搭车）**

视觉改版（V1-V4，Orca 对应实现均已考证）：

- **V1 侧栏分组化**：现 13-14 个 Section 平铺一列 → 按分组组织（Orca：280px 侧栏、8 分组、11px 大写字距分组标签、激活态 accent+ring）。我方分组草案（实施时定稿）：外观与交互（通用/壁纸/终端/快捷键）· AI 与启动（Provider/CLI 启动器/共享 MCP）· 系统（代理/Web 访问/通知/截图/语音）· 伙伴（ccchan）· 实验（新）· 关于。
- **V2 内容区软卡片带**：section 标题层级（大标题 + muted 描述）+ 设置块用软卡片（Orca：`rounded-xl border/50 bg-card/50 px-7 py-6 shadow-xs`，映射到我方 `--app-*` token），告别一撸到底的表单流。
- **V3 表单解剖统一**：全部控件按 house style 归一——label 组（label + 12px muted 描述）、密度分级（整段 space-y-3 / 紧凑 space-y-2）、**尾部元数据放控件下方**（"当前: 14px · 默认: 13px"式）、按钮变体优先级（Cancel 绝不 destructive）。此条同时回写 docs/46 表单小节成为宪法条款。
- **V4 单 pane 聚焦**：一次只显示一个 pane（配 M3 懒挂载），顶部常驻搜索框。

架构层（M1-M5，与视觉同批实施因为骨架就是重写载体）：设置注册表（驱动侧栏+CommandPalette，P1-2 完全体）→ 搜索分层打分 → 懒挂载 → SearchableSetting 控件过滤+深链 → Experimental pane+毕业机制（与 docs/52 模块实验区共用）。

现有各 Section 的**设置项内容不增不删**——批 1 只改壳与形，功能扩充在批 2。

**批 2：功能面扩充（勾选后逐项）**——F1 per-project pane（~1.5d）→ F2 实验区住户迁移 → F3/F4/F6 按需。

## 4. 待用户拍板

1. 批 1 架构改版整体是否认可（M1-M5 全吸收）？
2. F1-F6 勾选哪些？（本文建议：F1、F2 必要；F3/F4/F6 酌情；F5 暂缓）
3. 批 1 是否进 0.11.1？（体量 ~3-4d，与 P1-6 右坞线并行会拉长本版；也可作为 0.11.2 主线之一）
