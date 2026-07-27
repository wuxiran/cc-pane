# 67 · 发现性计划：主页装修 + Tips 扩容

> 计划文档，未排期到具体版本。可作为独立派工的交接件。
>
> 命题来自 [docs/58](./58-feature-tips.md) 自己的那句话：
> **「CC-Panes 的能力增长速度远超用户发现速度」**。
> 本文把它扩到两个面——**对外**（潜在用户在 GitHub 上看不到我们能干什么）与
> **对内**（已有用户不知道自己装了什么）——用一套共享的分镜脚本同时喂。
>
> **范围声明**：「完善人机交互」被拆成两份计划。本文只管**发现性**
> （用户不知道我们能干什么）；**交互质量**（知道了但用起来别扭——快捷键体系、
> 操作可逆性、空态一致性）另见 [docs/68](./68-interaction-quality-plan.md)。
> 两份不重叠。
>
> 附属件：[67 附录 · 素材分镜脚本](./67-storyboards.md)——主页 GIF 与 in-app tips
> 的唯一共享物，两边各实现一次。

## 0. 一个问题，两个面

| 面 | 症状 | 现状数字 |
|---|---|---|
| 对外·GitHub 主页 | 静态截图讲不了核心卖点 | 16 张图**全是静态 PNG**，0 个动态素材 |
| 对内·in-app tips | 能力发现不了 | `featureTipRegistry.tsx` 只注册 **4 条** |
| 教程 | **不缺内容，缺路径** | `docs/guide/` 已有 **19 篇**，分四层组织完好 |

第三行是本计划最重要的发现：**不要再写教程了**。要建的是通往教程的路。

## 1. 现状诊断

### 1.1 主页：静态图物理上表达不了我们的差异化

CC-Panes 的卖点是「一个 agent 派工给另一批 agent 并盯着它们跑」——
**这是时间维度的东西**。静态截图只能显示「有很多面板」，与任何分屏终端的截图无异。

> 这与 [docs/64](./64-ai-panel-templates.md) §6 得到的结论同构：
> 「静默时长」用数字和颜色都表达不了，只有轨迹（时间序列）能表达。
> 主页面临的是同一类问题的外部版本。

### 1.2 主页：贡献者内容与 CONTRIBUTING.md 两处并存且互不知晓

> **本节已按实测修正。** 初稿称「第 155 行之后的 116 行（43%）是贡献者内容，
> 潜在用户读到一半开始看 `cargo clippy` 就走了」——**这个论断不成立**。
> 那 105 行（EN 165–269、zh 165–277）**已经被包在 `<details>` 折叠块里**
> （EN 162–270、zh 162–278），默认不可见，不存在「读到一半被赶走」。

真正的问题是三个，都比篇幅严重：

1. **两份 README 里没有任何一处链接到 `CONTRIBUTING.md`**（全文搜不到该字样），
   而它已存在 189 行，与折叠块内容大面积重复——`Checks` 一节完全重复，
   `Quick Start` / `Build` / `Architecture` / `Contributing` 部分重复。
   两处并存、互不引用、各自漂移。
2. **仓库名不一致**：README 与全部 badge 用 `wuxiran/cc-pane`（单数），
   `CONTRIBUTING.md` 第 31 / 168 / 179 行用 `wuxiran/cc-panes`（复数）。
   其中一组链接是坏的。
3. **`CONTRIBUTING.md` 路径已过时**：第 70 / 90 / 101 / 105–107 行仍写 `src/`，
   而实际前端目录是 `web/`。照它上手的新贡献者会找不到文件。

其余问题：
- 顶部 **9 个 badge**（不是初稿说的 10 个）挤成一堵墙，信息密度极低，视线被挡在正文之前；
- `## Screenshots` 用 2×2 表格塞 4 张图，没有一张在说明「怎么用」；
- 安装入口（`## ⬇ Download`）排在第 84 行，在赞助商之前但在大量正文之后。

### 1.3 Tips：注册了 4 条，覆盖不到 docs/58 点名的任何一项

已注册：`command-palette` / `layout-switcher` / `mini-mode` / `unified-launcher`。

docs/58 点名「用户永远不会知道它们存在」的能力面——
**skill 体系、派工编排、右坞、布局密度、浏览器 tab、AI 面板、worktree 隔离**——
**一条都没覆盖**。当前 4 条全是「UI 操作技巧」，最贵的编排能力一条没有。

### 1.4 对标 orca

Orca（stablyai/orca，YC 系，"ADE — Agent Development Environment"）
2026-03 建仓，四个月 27.1k stars、6.7 release/天。MIT 免费。

**调研结论（2026-07-27 实时抓取，29.5k stars / MIT / 默认分支 main）**：

| 维度 | orca 的做法 | 我们抄不抄 |
|---|---|---|
| 结构 | 定位句 → hero 图 → **功能墙（占正文 52%）** → 安装 → 社区 → Developing 链接 | 抄骨架 |
| 首屏文案 | "The AI Orchestrator for 100x builders."，**不解释「ADE 是什么」** | 抄形态但**要补一句问题陈述**（见下） |
| 动态素材 | 9 组 GIF。**完全没有视频**——全文不出现 `.mp4`/`.webm`/`.mov` | 抄 |
| 双形态 | `<picture>` + `<source srcset type="image/gif">` + JPG fallback（约 1/30 体积） | **抄，最高价值发现** |
| 图即导航 | 每个 `<picture>` 外包 `<a>` 链到对应功能文档页 | 抄——这正是「建通往教程的路」在主页侧的实现 |
| 托管 | 100% 仓库内相对路径 `docs/assets/feature-wall/`，零 release assets、零图床 | 抄 |
| 素材库 | 实有 14 组、README 只用 9 组（多录后挑） | 抄，我们录 8 上 6 |
| badge | 7 个，含一个**自托管 SVG** 的 downloads（shields.io 无该端点） | 部分抄 |
| 贡献者内容 | README 的 `## Developing` 只有三样：CONTRIBUTING 链接 + 贡献者墙 + star history | 抄 |
| YC 背书 / 29.5k stars 生态 | star badge、star history、贡献者墙、大厂 logo 墙 | **抄不了**——这些是结果不是手段 |
| 6 语言本地化 | `docs/readme/` 下 6 份 | 抄不了，维护成本按语言线性增长 |

**一条反向提醒**：orca 首屏敢直接进功能墙，是因为它靠 YC 背书 + 29.5k stars
承担了概念教育。我们照抄这个顺序会缺一句「这解决什么问题」——
保留它的顺序骨架，但在定位句处补上问题陈述。

## 2. 主页装修

### 2.1 重排结构

目标：**首屏 30 秒内让人知道这是什么、凭什么不一样、怎么装**。

```
1  Hero        一句话定位 + 一张会动的主视觉（编排全景）
2  30 秒理解    3 段各 <10s 的循环短片，一段一个差异化能力
3  安装         平台三选一，直达 release（从第 84 行提到这里）
4  能力矩阵     表格，不是 bullet 墙
5  教程入口     → docs/guide 四层目录，一行一层
6  社区 / 赞助 / Star History
7  贡献者        **一行链接** → CONTRIBUTING.md
```

badge 从 10 个砍到 4 个（version / downloads / platform / license），其余移到底部或删。

### 2.2 三段短片拍什么

选片标准：**静态图表达不了、且是别人没有的**。

| 片 | 内容 | 为什么是它 |
|---|---|---|
| A · 派工编排 | 一个 agent 用 `launch_task` 拉起 3 个 worker，各自在独立 worktree 里跑，leader 收回执 | 唯一真正的差异化；也是静态图最无能为力的 |
| B · 分屏并行 | 多个 CLI 在分屏里同时跑，状态色实时跃迁 | 第一眼的震撼来源 |
| C · 移动端接管 | 桌面会话在手机上接管继续 | 独有能力，且演示成本低 |

**不要拍**：设置页、文件树、Git 面板——这些每个同类工具都有，拍了等于自证平庸。

### 2.3 贡献者内容搬家

`Quick Start From Source` / `Build` / `Checks` / `Architecture` /
`Repository Layout` / `Development Notes` 全部移入 `CONTRIBUTING.md`。
主页保留一行：`Building from source? See CONTRIBUTING.md`。

中文版 `README.zh-CN.md` 同步改，**双语必须一起改**（风格宪法 §7 硬约束）。

## 3. dev 素材管线

### 3.1 用 dev 实例录，但有三个坑

1. **窗口标题是 `CC-Panes [DEV]`**（`tauri.dev.conf.json` 覆盖），托盘 tooltip 同理。
   录进去就会出现在主页上。要么录前临时改配置，要么构图时裁掉标题栏。
2. **脱敏**：真实项目路径、workspace 名、provider key、token、MCP URL 里的 launchId。
   dev 数据目录是 `~/.cc-panes-dev/`，建议**专门造一套演示数据**而不是用真实工作区。
3. **体积**：GIF 放进仓库会让 clone 变重。需先定策略（见 §5）。

### 3.2 规格

- 循环短片，无声，≤10s，宽度 ≤1200，体积目标单个 ≤2MB
- 演示数据固定（同一套项目名 / 分支名），三段片风格统一
- 存放 `docs/assets/media/`，与现有 `docs/assets/images/` 分开

## 4. Tips 扩容

### 4.1 补什么

按「用户永远发现不了 × 价值高」排序，第一批建议 6 条：

| tip | 指向 |
|---|---|
| 派工编排（launch_task） | 最贵的能力，当前零覆盖 |
| worktree 隔离执行 | 并行改代码的前提，不知道就不敢并行 |
| 右坞与会话历史 | 已实现但入口隐蔽 |
| AI 面板 | 0.11.3 刚交付，无人知晓 |
| skill 体系 | 能力总入口 |
| 浏览器 tab | 差异化功能 |

每条 tip 的落点是 **`docs/guide/` 对应那一篇**——这就是 §0 说的「建通往教程的路」。

> **落点实测：6 条里只有 2 条有路可通。**
>
> | tip | guide 落点 |
> |---|---|
> | 派工编排 | ✅ `12-leader-worker.md` |
> | worktree 隔离 | ✅ `07-git-worktree.md` |
> | AI 面板 | ❌ 全 guide 零提及 |
> | 右坞 | ❌「右坞」一词零出现 |
> | 浏览器 tab | ❌ 4 篇提到「浏览器」但全指外部浏览器访问 Web 端 |
> | skill 体系 | ⚠️ 4 篇顺带提及，无专篇 |
>
> 已决：**破例补写这 4 篇**（见 §6 修订）。否则「建路」对它们落空。

### 4.1.1 扩容前必须先做的两件事

1. **`FeatureTipDefinition` 没有落点链接字段**（`featureTipRegistry.tsx:14-24`）。
   要实现「tip → guide」必须先扩字段并在 `FeatureTip.tsx` 加渲染位。
2. **这 6 条多数没有对应的 shortcuts action**，套不了现有的 `shortcutTip()` 辅助
   （`:137-145`，它假设「一条 tip = 一个快捷键 action」，当前 4 条全走它），
   需要手写 `tryAction` / `eligible`。

### 4.1.2 前置修复：现有 4 条里 3 条在教无效快捷键

见 §5.1 第 4 条。**必须先修再扩容**，否则错误形态被复制 10 份。

### 4.2 一个必须遵守的红线：tips 的演示不能用位图

风格宪法 [docs/46](./46-frontend-styleguide.md) §6.1：

> 演示只用 CSS、HTML 或内联 SVG 表达真实交互关系，
> **不使用产品截图、位图占位或需要网络加载的素材**；
> 动画必须使用现有 duration/easing token，并在 `prefers-reduced-motion` 下停用位移与循环。

**所以主页素材与 tips 演示不能共用文件。** 共用的是**分镜脚本**——
同一个交互，主页渲染成 GIF，应用内用 CSS/SVG 重画一遍。
计划里必须为每条能力写一份脚本，两边各自实现。

### 4.3 打扰闸门

复用 [docs/60](./60-notify-ui-handoff.md) 已有的闸门，不新造。
tips 是长尾，**一次只冒一条，可永久关闭**。

## 5. 开放问题 —— **已全部拍板**

1. ~~**orca 主页形态**~~ → **已调研**（2026-07-27）。结论见 §1.4 与
   [67-storyboards](./67-storyboards.md) §0。关键三条：
   Features 占正文 52%、9 组 GIF 排成功能墙；
   **完全没有视频**（全文不出现 `.mp4`/`.webm`/`.mov`），动态一律是 GIF；
   `<picture>` + `<source srcset type="image/gif">` + JPG fallback 的双形态写法。
2. ~~**GIF 体积策略**~~ → **进仓库**。对标 orca：零 release assets、零外部图床、
   100% 仓库内相对路径。单 GIF ≤2MB（实测 orca 区间 217KB–1.96MB），
   JPG fallback ~25KB。规模按「多录少用」：录 8 组、README 上 6 组。
3. ~~**范围**~~ → **两者都要**。发现性归本文；交互质量归
   [docs/68](./68-interaction-quality-plan.md)。见文首范围声明。

### 5.1 实施中新发现的必答问题（已答）

4. **tips 教的快捷键在终端聚焦时失效**。`useShortcutsStore.ts:16-24` 的
   `TERMINAL_PASSTHROUGH_ACTIONS` 含 7 条，而现有 4 条 tip 里
   **3 条（`command-palette` / `unified-launcher` / `mini-mode`）恰好都在清单里**——
   用户照 tip 按下去没反应，直接违反 docs/58 §1.1「教错快捷键比不教更糟」。
   → **已决**：不动产品行为，从 `TERMINAL_PASSTHROUGH_ACTIONS` 派生限制说明。
   作为前置修复线 L0 先于扩容执行。放行清单本身是否该重划，归 docs/68。
5. **6 条 tip 里 4 条没有 guide 落点**。见 §4.1 修订。
   → **已决**：破例补写 4 篇 guide，见 §6 修订。

## 6. 明确不做 —— **§6.1 已被推翻**

- ~~**不写新教程**~~ → **推翻**。初稿论断「`docs/guide/` 19 篇已覆盖四层，
  缺的是路径不是内容」**只对一半**：guide 覆盖完好的是**上一代能力**，
  而 docs/58 点名「用户永远不会知道存在」的那批新能力，教程里同样不存在。
  实测：AI 面板全 guide 零提及、「右坞」一词零出现、
  4 篇提到「浏览器」但全指外部浏览器访问 Web 端（无一处讲应用内 tab）、
  skill 仅 4 篇顺带提及无专篇。对这 4 条是**路和终点都缺**。
  → **已决补写 4 篇**（AI 面板 / skill 体系 / 右坞 / 浏览器 tab），
  否则 tips 扩容无落点可指。派工见 L5。
- **不做首启引导改造**。docs/56 黄金五分钟已覆盖头 5 分钟，tips 是它的长尾延续，两者不重叠。
- **不改产品 UI 去迁就演示**。素材要拍真实形态，不为好看临时改界面。
- **不做 tips 的触发智能**（用量计数、上下文触发）。本文只管 tips 的**内容扩容**；
  docs/58 §3.3 点名「不要长期缺席」的上下文触发机制归 docs/68。
