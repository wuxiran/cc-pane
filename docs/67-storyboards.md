# 67 附录 · 素材分镜脚本

> [docs/67](./67-discoverability-plan.md) 的附属件。**这份脚本是主页素材与 in-app tips
> 的唯一共享物**——两边各实现一次，不共用文件。
>
> 原因是风格宪法 [docs/46](./46-frontend-styleguide.md) §6.1 的硬约束：
> tips 的演示「只用 CSS、HTML 或内联 SVG……**不使用产品截图、位图占位或需要网络加载的素材**」。
> 所以同一个交互，主页录成 GIF，应用内用 CSS/SVG 重画。

## 0. 已拍板的参数

| 项 | 决定 | 依据 |
|---|---|---|
| 素材托管 | **提交进仓库**，`docs/assets/feature-wall/` | 对标 orca：零 release assets、零外部图床、100% 仓库内相对路径 |
| 形态 | **GIF + JPG 双形态**，`<picture>` 降级 | orca 的做法，动态是增强而非依赖 |
| 录多少 | **录 8 组，README 先上 6 组** | 用户拍板「多录少用」（orca 素材库 14 组只用 9 组） |
| 单个体积 | GIF ≤2MB（目标 700KB 上下），JPG fallback ~25KB | orca 实测区间 217KB–1.96MB，JPG 约为 GIF 的 1/30 |
| 时长 | ≤10s，循环，无声 | docs/67 §3.2 |
| 宽度 | ≤1200 | docs/67 §3.2 |

体积总账：8 组全录约 5.6MB，README 上的 6 组约 4.2MB。
参照：仓库现有全部素材（10 PNG + 2 HTML）合计 **1.4MB**。
素材进 git 历史后删不掉，这是一次性的、不可逆的体积增加。

### 必须抄的 README 写法

```html
<a href="docs/guide/12-leader-worker.md">
  <picture>
    <source srcset="docs/assets/feature-wall/dispatch-orchestration.gif" type="image/gif">
    <img src="docs/assets/feature-wall/dispatch-orchestration.jpg"
         alt="一个 agent 派工给三个 worker，各自在独立 worktree 中执行" width="100%">
  </picture>
</a>
```

三个要点：`<source>` 用 `srcset=` 不是 `src=`；fallback 是 JPG；
**整个 `<picture>` 外面包 `<a>` 链到对应 guide 篇**——图既是展示也是导航入口，
这正好是 docs/67 §0 说的「建通往教程的路」在主页侧的实现。

---

## 1. 录制前的准备

### 1.1 窗口标题会把 `[DEV]` 录进主页

`tauri.dev.conf.json` 覆盖了 identifier 与窗口标题，dev 实例标题是 `CC-Panes [DEV]`，
托盘 tooltip 同理。三个解法，按推荐度排：

1. **临时改 `tauri.dev.conf.json` 的窗口标题为 `CC-Panes`**，录完改回。
   最简单，且不动 identifier 所以仍与 release 数据隔离。**推荐这个。**
2. 构图时裁掉标题栏。省事但会失去窗口边界，画面显得没有产品感。
3. 用 release 版录 —— **不推荐**，release 数据目录是 `~/.cc-panes/`，
   里面是真实工作区，脱敏成本高。

### 1.2 专门造一套演示数据

不要用真实工作区。dev 数据目录是 `~/.cc-panes-dev/`，新建一个演示工作空间。

固定用下面这套，**八组素材必须全部用同一套**，否则拼在一起像不同产品：

| 项 | 值 |
|---|---|
| 工作空间 | `acme` |
| 项目 | `acme-web`、`acme-api`、`acme-docs` |
| 路径 | `D:\demo\acme-web` 等（**不要出现真实的 `D:\04_workspace_rust\`**） |
| 分支 | `main`、`feat/checkout`、`fix/login-redirect` |
| worktree | `acme-web-wt-checkout`、`acme-web-wt-login` |

### 1.3 脱敏检查清单（每段录完逐条过）

- [ ] 窗口标题无 `[DEV]`
- [ ] 无真实项目路径（搜画面里的 `04_workspace_rust`、`wuxiran`）
- [ ] 无 provider key / token
- [ ] 无 MCP URL（里面带 `launchId`）
- [ ] 无真实工作空间名
- [ ] 终端里无真实 git remote / 用户名
- [ ] 通知区无其它应用的私人内容

---

## 2. 八组分镜

每组给四件事：**主页 GIF 的镜头序列**、**tips 演示要点**（CSS/SVG 版）、
**guide 落点**、**这组为什么值得拍**。

tips 演示一律遵守：
- 用 Tailwind + `var(--app-*)` token，文字用骨架条（`h-1.5 w-24 rounded-full bg-[var(--app-hover)]`）代替真实文案，天然免 i18n
- 套 `VisualStage`（`featureTipRegistry.tsx:34-40`）
- 动画用 `var(--dur*)` token，**不要用 Tailwind 的 `animate-pulse`**
  （现有 `MiniModeVisual:104` 是这么写的，属于既存偏差，别复制）
- `prefers-reduced-motion` 下停用位移与循环
- 右栏对读屏 `aria-hidden`，**所有信息必须同时在左栏文字里可获得**

---

### A · 派工编排 ★README

**为什么是它**：唯一真正的差异化，也是静态图最无能为力的——
「一个 agent 派工给另一批 agent 并盯着它们跑」本质是时间维度的东西。

**GIF 分镜（9s）**

| 时间 | 画面 |
|---|---|
| 0–2s | 单个 Claude 会话，用户敲一句「把这三个模块并行重构」 |
| 2–4s | 界面分裂出 3 个 pane，每个标题栏显示不同 worker 名与分支 |
| 4–7s | 三个 pane 同时滚动输出，状态点从灰→蓝（busy）各自跃迁 |
| 7–9s | 三个陆续转绿（done），leader pane 汇总出一行回执，定格 |

关键：**必须让三个 worker 的进度不同步**——同时开始、先后结束。
整齐划一看着像假的，也丢掉了「盯着它们跑」的意味。

**tips 演示**：一个 leader 方块，三条连线向下接三个 worker 方块。
三个 worker 的状态点用**不同 delay** 的颜色过渡（灰→蓝→绿），
reduced-motion 下直接呈现终态（一蓝两绿），不做过渡。

**落点**：`docs/guide/12-leader-worker.md`

---

### B · 分屏并行 ★README

**为什么是它**：第一眼的震撼来源。但要小心——单看「有很多面板」与任何分屏终端无异，
差异必须来自**状态色实时跃迁**，那是别人没有的。

**GIF 分镜（8s）**

| 时间 | 画面 |
|---|---|
| 0–1s | 2×2 四宫格，四个 CLI 会话 |
| 1–6s | 四个同时输出，状态点各自跃迁：busy→waitingInput（琥珀）→busy→done |
| 6–8s | 其中一个转琥珀（等输入），鼠标点进去敲一行，转回蓝色 |

最后那 2s 是重点：**琥珀 = 等你**。这传达的是「你不用盯着，它会叫你」。

**tips 演示**：四个矩形，四个状态点按不同 delay 循环 灰→蓝→琥珀→绿。
琥珀那格加一圈 ring 强调。注意 docs/46 有琥珀约定，取色前先对照。

**落点**：`docs/guide/11-parallel-run.md`

---

### C · 移动端接管 ★README

**为什么是它**：独有能力，且演示成本最低（不需要复杂前置状态）。

**GIF 分镜（8s）**

| 时间 | 画面 |
|---|---|
| 0–3s | 桌面端一个会话跑着，状态转琥珀（等确认） |
| 3–5s | 画面右下角推入一个手机画框，同一个会话出现在手机上 |
| 5–8s | 手机上敲一行、提交，桌面端同步刷出同样内容，状态转回蓝色 |

构图建议桌面画面缩到左侧 2/3，手机画框叠在右下——**两端同屏**才能表达「同一批会话」。

**tips 演示**：左侧一个宽矩形（桌面），右侧一个窄高矩形（手机），
中间一条连线上有个小圆点从左往右移动一次后停住。

**落点**：`docs/guide/16-web-and-mobile.md`

---

### D · worktree 隔离 ★README

**为什么是它**：并行改代码的前提。用户不知道这个就不敢并行——
这是「知道了才敢用」的典型，价值高于它的展示成本。

**GIF 分镜（8s）**

| 时间 | 画面 |
|---|---|
| 0–2s | 项目树显示 `acme-web`（分支 main） |
| 2–4s | 创建两个 worktree，树上嵌套出现两个子节点，各自分支名不同 |
| 4–7s | 两个 worker 分别在两个 worktree 里改文件，**主树 git status 保持干净** |
| 7–8s | 定格在「主树 clean / 两个 worktree 各有改动」的三方对照 |

最后那个三方对照是全片的论点：**别动我主树**。

**tips 演示**：一个主节点 + 两个缩进子节点，各带一个分支标签。
主节点旁一个绿色 ✓（clean），两个子节点旁各一个蓝点（有改动）。静态即可，不需要动画。

**落点**：`docs/guide/07-git-worktree.md`

---

### E · AI 面板 ★README

**为什么是它**：0.11.3 刚交付，无人知晓。

> ✅ 落点已就位：`docs/guide/17-ai-panel.md`。
> 注意 `docs/64` 是**未排期的方向文档**——面板模板化（`templateId`）与 fleet 编排拓扑
> **代码里都不存在**（只有 `content: String` 一条路），分镜不要拍。

**GIF 分镜（7s）**

| 时间 | 画面 |
|---|---|
| 0–2s | 一个终端会话在跑 |
| 2–5s | agent 经 MCP 往面板投递内容，面板从侧边推入并填充 |
| 5–7s | 用户翻面板历史，看到之前几条投递记录 |

**tips 演示**：一个终端矩形 + 一个面板矩形，中间一条箭头。
面板内三条骨架条按 delay 依次淡入。

**落点**：`docs/guide/17-ai-panel.md`

---

### F · skill 体系 ★README

**为什么是它**：能力总入口。用户装了一堆 skill 却不知道怎么触发。

> ✅ 落点已就位：`docs/guide/18-skills.md`。
>
> **L5a 实测挖到的事实，直接改变这组的拍法**：manifest 会把 **24 个**内置 skill
> 发布到磁盘，但运行配置 UI 的「CC-Panes 内置 Skill」勾选清单**只列 4 个**
> （`core_skill_ids()`，注释明说「默认 core 仅保留高频 4 个；其他 skill 仍会发布到磁盘」）。
> 用户看到 4 个会以为只有 4 个。

**GIF 分镜（8s）**

| 时间 | 画面 |
|---|---|
| 0–2s | 用户敲 `/`，skill 列表弹出 |
| 2–4s | 列表滚动，显示内置 skill 的规模 |
| 4–8s | 选一个执行，会话按 skill 流程跑起来 |

中段的「滚动展示规模」是关键——**数量本身就是论据**。
拍的是 `/` 弹出的完整列表（24 个），**不要拍设置里那个只有 4 项的勾选清单**，
那会把最强的论据拍成最弱的。

**tips 演示**：一个输入框 + 下方 5 条列表项，第 2 条高亮。
列表项左侧小图标，右侧骨架条。静态。

**落点**：待 L5a 定

---

### G · 右坞（备用，不上 README）

> ✅ 落点已就位：`docs/guide/19-right-dock.md`。
>
> **教程里必须写、演示里不要暗示的坑**：`show-explorer` / `show-sessions` /
> `show-files` 三个 action **没有默认快捷键**，且在「设置→快捷键」页面
> 不可见、无法绑定，只能从命令面板触发。
> 所以 tips 演示**不要画快捷键 chip**，会误导。
>
> L5b 补充的一层：命令面板本身走 `Ctrl+K`，而 `Ctrl+K` **在放行清单里**——
> 终端聚焦时它也不生效。于是「只能从命令面板触发」这条唯一逃生路径
> **在产品的默认状态下同样是断的**，必须先点终端以外的区域。
> 这条已写进 19 篇正文。

**GIF 分镜（6s）**：右坞推入 → 切换文件/Git 视图 → 点开一个文件

**tips 演示**：主区域 + 右侧推入的窄栏，栏内两个 tab 切换态。

---

### H · 浏览器 tab（备用，不上 README）

> ✅ 落点已就位：`docs/guide/20-browser-tab.md`。
>
> **消歧**：这是**应用内的浏览器标签页**，不是 `16-web-and-mobile.md` 讲的
> 「外部浏览器访问 Web 端」。两者极易混淆，文案和演示都要点破。
>
> ⚠️ **本组分镜已按 L5b 实测重写。原分镜写的「用户开一个浏览器 tab」不成立**：
> 全仓库唯一的 `openBrowser()` 调用点是 `useOrchestratorListener.ts:283`
> （监听 MCP 事件）——**用户自己开不了，只能让 AI 开**。
>
> 另：`browser_evaluate` / `browser_screenshot` / `browser_click`
> **只在 Windows 可用**（走 WebView2 CDP，`browser_service.rs:529-536`
> 非 Windows 直接返回错误）；`open_browser_tab` / `browser_navigate` 三平台可用。
> 录制素材时若要拍截图/点击能力，**必须在 Windows 上录**。

**GIF 分镜（7s，已重写）**

| 时间 | 画面 |
|---|---|
| 0–2s | 用户对 agent 说一句「打开这个文档看一下」 |
| 2–4s | **agent 自己开出**浏览器 tab 并导航过去 |
| 4–7s | agent 截图页面、读取内容，把结论写回终端 |

这组的论点不是「内嵌了个浏览器」（那谁都有），而是**浏览器是 agent 的手不是你的手**。
既然用户没有 UI 入口，分镜就不能有「用户点开浏览器」这个动作——拍了就是拍了个不存在的功能。

**tips 演示**：一个带地址栏的矩形 + 旁边一个 agent 图标，一条箭头**从 agent 指向页面**
（方向很重要，反了就变成「你去开」）。

---

## 3. README 上哪 6 组

**上**：A 派工编排 / B 分屏并行 / C 移动端接管 / D worktree 隔离 / E AI 面板 / F skill 体系
**备**：G 右坞 / H 浏览器 tab

G 和 H 在 tips 里用 CSS 版，主页素材录好备着，后续需要时换上。

### 排序建议

按「差异化强度」降序，不按功能重要性：**A → B → D → C → E → F**。
理由：A 和 B 承担第一眼，D 解释 A 为什么可行，C 是独有能力，E/F 是新能力补充。

### 不要拍

设置页、文件树、Git 面板、编辑器。这些每个同类工具都有，拍了等于自证平庸。

---

## 4. 与 tips 扩容（L2）的对齐

L2 要补 6 条 tip，与本文的对应关系：

| tip | 本文分镜 | 落点 |
|---|---|---|
| 派工编排 | A | `12-leader-worker.md` ✅ 既有 |
| worktree 隔离 | D | `07-git-worktree.md` ✅ 既有 |
| AI 面板 | E | `17-ai-panel.md` ✅ 已补 |
| skill 体系 | F | `18-skills.md` ✅ 已补 |
| 右坞 | G | `19-right-dock.md` ✅ 已补 |
| 浏览器 tab | H | `20-browser-tab.md` ✅ 已补 |

**六条 tip 的落点已全部就位**，L2 可以开工。

B（分屏并行）与 C（移动端接管）**只做主页素材，不做 tip**——
分屏是用户第一天就会碰到的，不属于「永远发现不了」那一类；
移动端接管在 `16-web-and-mobile.md` 里已有完整教程，且 docs/56 首启引导已覆盖。

### L2 需要的结构改动（先于内容）

`FeatureTipDefinition`（`featureTipRegistry.tsx:14-24`）**当前没有任何落点链接字段**。
要实现「tip → guide」必须先扩字段并在 `FeatureTip.tsx` 加渲染位。

另：这 6 条中多数没有对应的 shortcuts action，
**套不了现有的 `shortcutTip()` 辅助**（`:137-145`，它假设「一条 tip = 一个快捷键 action」），
需要手写 `tryAction` / `eligible`。

---

## 5. 待办与未决

- [x] ~~E/F/G/H 四组的 guide 落点文件名~~ —— 已回填（17 / 18 / 19 / 20）
- [ ] 四篇新 guide 里共 7 处 `<!-- TODO(img) -->` 占位待统一收口
      （17 篇 2 处、18 篇 2 处、19+20 篇 3 处），需先定素材策略
- [ ] 演示工作空间 `acme` 的数据构造 —— 未开始
- [ ] 八组素材录制 —— 未开始，需人工操作 GUI
- [ ] JPG fallback 的截取时点 —— 建议取 GIF 的**终态帧**而非首帧
      （终态信息量最大；orca 的 JPG 约为 GIF 的 1/30 体积）
