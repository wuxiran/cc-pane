# L1 · 主页重排（非素材部分）

> 属于 [docs/67](../docs/67-discoverability-plan.md) 发现性计划。
> **本轮只做不依赖素材的部分**——GIF/录屏尚未拍摄（需人工操作 GUI），
> 功能墙留占位，素材到位后另派一轮插入。
>
> 分镜与素材规格见 [docs/67-storyboards.md](../docs/67-storyboards.md)，
> 本 plan 不重复。

## 你要改的文件（就这三个）

`README.md`、`README.zh-CN.md`、`CONTRIBUTING.md`

**不要碰任何其它文件。** 同期有其它 worker 在改 `docs/`、`web/`、`CLAUDE.md`。

---

## 任务 1 · 修两个已坐实的错误

### 1.1 仓库名不一致

**真实仓库是 `wuxiran/cc-pane`（单数）** —— 已由 `git remote -v` 确认：
`https://github.com/wuxiran/cc-pane.git`。

README 两份与全部 badge 用的是单数（**正确，不要动**）；
`CONTRIBUTING.md` 第 **31 / 168 / 179** 行用了 `wuxiran/cc-panes`（复数），
**这三处是坏链接，改成单数**。

改完全文再搜一遍 `cc-panes`，确认没有漏网的仓库 URL
（注意：正文里作为**产品名**出现的 "CC-Panes" 是对的，只改 URL/clone 地址里的 slug）。

### 1.2 CONTRIBUTING.md 的前端目录路径过时

第 **70 / 90 / 101 / 105–107** 行仍写 `src/`，实际前端目录是 **`web/`**
（README 第 244/254 行与 CLAUDE.md 均为 `web/`）。
包括 `@/` 别名的映射说明——`@/` 映射到 `web/`，不是 `src/`。

改完搜一遍确认没有残留的 `src/` 误指（`src-tauri/` 是对的，别误伤）。

---

## 任务 2 · README 与 CONTRIBUTING 合流

### 现状（已实测，不要重新调查）

- 两份 README 的贡献者内容**已经在 `<details>` 折叠块里**
  （EN 162–270、zh 162–278），默认不可见。
  **所以这不是「篇幅赶走用户」问题**，docs/67 初稿的 43% 论断已作废。
- 真正的问题：**两份 README 里没有任何一处链接到 `CONTRIBUTING.md`**
  （全文搜不到该字样），而它已存在 189 行且大面积重复：
  - `Checks` 一节与 CONTRIBUTING 的 `### Useful Commands` **完全重复**
  - `Quick Start From Source` 与 `## Development Environment` 高度重复，
    **但命令不一致**：README 用 `npm run tauri:dev`（dev 隔离版），
    CONTRIBUTING 用 `npm run tauri dev`（不隔离）——**以 README 的为准**，
    dev 隔离是我们要推荐的默认姿势。
  - `Contributing`（Conventional Commits）与 `## Commit Message Format` 重复，
    **CONTRIBUTING 的更完整**，保留它的。

### 要做的

把 `<details>` 里的内容按「谁更完整留谁」合并进 `CONTRIBUTING.md`，
README 折叠块**整体删除**，替换为一行链接。

**README 独有、CONTRIBUTING 没有的，必须搬过去不能丢**：
- `Repository Layout`（目录树）
- `Development Notes` 的 **dev/release 隔离表** + Windows 验证段
  （这是 CC-Panes 的特色机制，CONTRIBUTING 完全没提）
- `Architecture` 里的**技术栈表**（CONTRIBUTING 的 `## Project Structure` 只有分层链路）

**中文版有一节英文版没有**：`### WSL 原生开发`（zh 206–215，
讲 `CCPANES_TERMINAL_BACKEND=wsl npm run tauri:dev`）。
`CONTRIBUTING.md` 是纯英文，搬过去时**把这节译成英文一并纳入**，不要丢内容。

README 保留的那一行，两份各自的语言：
- EN：`Building from source? See [CONTRIBUTING.md](CONTRIBUTING.md).`
- zh：`想从源码构建？见 [CONTRIBUTING.md](CONTRIBUTING.md)。`

---

## 任务 3 · badge 瘦身与 star 撤除

### 3.1 badge 砍到 4 个

当前 **9 个**（两份第 9–17 行，字节级一致）。保留这 4 个：

| 保留 | 理由 |
|---|---|
| Latest Release | 用户关心版本 |
| Downloads | 社会证明且不虚 |
| Platform | 用户第一时间要判断能不能装 |
| License | 合规信息 |

删掉这 5 个：**Stars**（见 3.2）、**CI**、**Tauri**、**React**、**Rust**。
后三个是技术栈 badge——对用户零信息量，属于给开发者看的东西。

> 技术栈信息不要丢，它已经在搬去 CONTRIBUTING 的技术栈表里了（任务 2）。

### 3.2 star 相关全撤（已拍板）

- 删 **Stars badge**
- 删 **`## ⭐ Star History` 整节**（两份第 139–144 行，含 star-history.com 的远程图）

理由：对标调研显示，star badge 与 star history 图在 orca 那里是 **29.5k stars 的结果**，
不是手段。低 star 阶段放它们是负信号——主动把「我们还很小」放在首屏。

---

## 任务 4 · 章节重排

目标结构（docs/67 §2.1），**本轮能做的部分**：

```
1  头部 div     logo + 4 badge + 导航行 + hero 图
2  一句话定位 + 问题陈述          ← 见下方「重要」
3  [功能墙占位]                  ← 本轮只留 HTML 注释，不插图
4  Screenshots                   ← 本轮保留不动（素材到位后由功能墙取代）
5  ⬇ Download                    ← 从第 84 行前移到这里
6  能力矩阵（现 Highlights 改造为表格）
7  教程入口 → docs/guide 四层，一行一层
8  Sponsors / Co-creators / Community
9  License / Acknowledgments
10 一行贡献者链接
```

### 重要：定位句要补一句问题陈述

对标调研的结论：orca 首屏**完全不解释「ADE 是什么」**，直接进功能墙——
它靠 YC 背书 + 29.5k stars 承担了概念教育，**我们没有那个本钱**。

所以：抄它的顺序骨架，但在定位句处**补一句问题陈述**（读者为什么需要这东西）。

现有素材可用：两份 README 第 27 行的简介段落**不是互译，是两套不同话术**
（EN 偏「支持哪些 CLI + provider profiles」，zh 偏「不是终端壳子，是补上项目组织/并行编排/上下文恢复」）。
**中文那套更接近问题陈述**，可据此重写英文版，让两份对齐到同一个定位。

### 功能墙占位写法

在第 3 位置留：

```html
<!-- TODO(media): 功能墙 6 组，见 docs/67-storyboards.md §3
     A 派工编排 / B 分屏并行 / D worktree 隔离 / C 移动端接管 / E AI 面板 / F skill 体系
     每组用 <picture> + <source srcset type="image/gif"> + JPG fallback，外包 <a> 链到对应 guide 篇 -->
```

**不要插入 `<picture>` 标签**——素材文件还不存在，插了就是破图。

### 教程入口

指向 `docs/guide/README.md` 的四层，一行一层。注意 guide 刚扩容到 **20 篇 + 索引**，
新增了 17 AI 面板 / 18 Skill 体系 / 19 右侧坞 / 20 应用内浏览器标签。

---

## 硬约束

### 双语必须一起改（docs/46 §7）

这是硬约束，不是建议。任何结构改动两份都要做。

**一个已有的好性质，尽量保住**：两份 README 的上半部分（1–160 行）目前是
**逐行同构**的——同行号、同 HTML 块、同表格结构。这让后续 diff 对照极其容易。
改完后请让两份仍保持结构一一对应（行号能对齐更好，对不齐也要保证章节顺序与块结构一致）。

### 不要动的东西

- 5 个 `docs/assets/images/` 引用中，**hero 图（第 23 行 `current-ui.png`）
  与 Screenshots 四张本轮保持不动**
- 微信二维码（第 136 行）不动
- Co-creators 的远程头像不动
- **不要新增任何图片文件**
- 不要碰 `docs/`、`web/`、`CLAUDE.md`

### 顺带发现

`docs/assets/images/screenshot-no-layout.png` 是**孤儿文件**，全仓库零引用。
本轮**不要删**（删文件是另一回事），只在上报里提一句。

---

## 验收

- [ ] `CONTRIBUTING.md` 三处仓库名已改为单数，全文无 `cc-panes` 的 URL slug
- [ ] `CONTRIBUTING.md` 中 `src/` 已全部改为 `web/`，`src-tauri/` 未误伤
- [ ] README 两份的 `<details>` 折叠块已删除，替换为一行链接
- [ ] README 独有的三块内容（Repository Layout / dev-release 隔离表 / 技术栈表）
      与中文独有的 WSL 原生开发节，**都已搬进 CONTRIBUTING 且未丢失**
- [ ] badge 两份各剩 4 个且一致
- [ ] Star History 整节已删，Stars badge 已删
- [ ] Download 已前移
- [ ] 定位句已补问题陈述，两份对齐到同一定位
- [ ] 功能墙位置留了 HTML 注释占位，**未插入 `<picture>`**
- [ ] 教程入口指向 guide 四层，且知道 guide 现在是 20 篇
- [ ] 两份 README 结构一一对应

**没有可跑的自动化检查**（纯 markdown）。请自己逐条对照上表，
并在上报里说明你如何确认「搬运未丢内容」——建议做一次搬运前后的条目清点。

## 边界

- 不要拍摄或生成任何素材
- 不要新建文件（`CONTRIBUTING.zh-CN.md` 本轮**不做**，中文贡献者内容译进英文版 CONTRIBUTING 即可）
- 不要提交 git

## 收尾

按 docs/65 观测契约上报。必须包含：
三个文件各改了什么、搬运的内容清点（搬前 N 条 → 搬后 N 条）、
你判断本 plan 有误或与实际不符的地方。
