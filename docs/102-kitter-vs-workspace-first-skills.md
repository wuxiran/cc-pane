# 102 — Kitter 对照与工作空间 Skill 有效集

对照 [Kitter](https://github.com/what1f/kitter) 与 CC-Panes 已落地的 workspace-first Skill 体系（[docs/97](97-skill-market.md)、[docs/98](98-ccpanes-dir-plan.md)）。本轮产品改动只扩工作空间 `skill-manager` 页：把「只看见工作空间自己的目录」改成有效集视图。

权威现状以 docs/97、docs/98 和代码为准。[docs/guide/18-skills.md](guide/18-skills.md) 仍按「写入 CLI Home」叙述，过时，不当作现状。

## 一句话结论

Kitter 的默认层是**仓库**（一份库、按项目链接安装）。CC-Panes 的默认层是**工作空间**（会话挂载插件目录，不写项目、不写 `~/.claude`）。该学的不是项目优先或 symlink，而是打开一页就能看到会话实际会碰到的全部 Skill，并标来源。

工作空间 Skill 页因此改成三段：工作空间（可写）/ 内置注入（开关 + 复制）/ 项目发现（搜索 + 点进编辑）。

## 一句话差异

| | Kitter | CC-Panes |
|---|---|---|
| 默认层 | 项目仓库（`.agents/skills` 或某 Agent 目录） | 工作空间 `~/.cc-panes/workspaces/<name>/skills/` |
| 权威副本 | 一份库，托管链接 | 市场 + 用户库 + 工作空间物化 + 仓库多根，彼此复制 |
| 全局 | 尽量少 | 内置插件目录按会话挂载；用户库走启动档 prompt |
| 有效集 | 项目视图摊开托管与非托管来源 | 启动档 `resolve_skills` 不完整；工作空间页原先只显示自有目录 |
| Token | 按 Agent 估自动载入的元数据 | 无（本轮仍不做） |
| 更新 | `check` / `update` 一次，链接项目跟上 | 重装即更新；复制出去的副本不跟着变 |

## 不该从 Kitter 抄过来的

1. 不要把默认安装改回项目目录。与 workspace-first / docs/98 / 「对项目零写入」冲突。
2. 不要为了对齐 Kitter 去写 `~/.claude/skills`。docs/97 已否；和 `--plugin-dir` 挂载重复且打架。
3. 不要引入 Kitter CLI，不要用 symlink 进 git。
4. 「链接代替复制」不是第一原则。工作空间挂载已经是一份目录、多会话引用。

## 本页规格（已落地）

`Skill - {workspace}` 一页三段卡片网格（对齐技能市场），顶部一条搜索（滤 name / description / 项目名）。点卡片再预览或编辑，不新开一堆 tab。

### 1. 工作空间（可写，默认层）

现有新建 / 导入 / 编辑 / 删除。来源角标 `workspace`。空了只说「还没有自己的技能」，不暗示整个会话没有 Skill。

### 2. 内置注入（可开关 + 可复制）

列出 `list_bundled_skills`。开关写入该工作空间绑定启动档（否则默认档）的 `skillPolicy`，id 为 `builtin:<name>`，变换复用 `nextToggleBuiltinSkill`。正文只读；「复制到工作空间」走 `import_skill` 源 `bundled`，不改内置原件。

**挂载粒度（诚实标注）**：Claude / Codex 的 `--plugin-dir` / `skills.config` 今天是整目录。Core/Custom 勾选主要作用于 session prompt。关了一条若仍会被原生挂载看到，卡片上标明。本轮不做子集物化。

### 3. 项目发现（列出 + 点进编辑）

`list_workspace_project_skills` 扫该工作空间未归档项目的五根（`.agents/skills`、`.claude/skills`、`.cursor/skills`、`.codex/skills`、`.gemini/skills`）。单项目失败跳过。点击后本页打开该项目 `SKILL.md`。本段不做新建或跨项目搬移。

## 后续可选（本轮不做）

- Token 估算（只估自动载入的 frontmatter + 描述）
- 库级 `check` / `update`；导入时留下 `sourceUrl` / sha
- Skill → 哪些工作空间在用 的反向索引
- 按启用列表物化临时 plugin-dir，让内置开关对 Claude/Codex 原生挂载也生效
- Daemon/web 补齐项目/工作空间 Agent Skills API
