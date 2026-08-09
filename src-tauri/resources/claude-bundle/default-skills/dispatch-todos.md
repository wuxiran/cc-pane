---
name: ccpanes-dispatch-todos
description: Query pending todos from {{app_name}}, cluster them by family, and dispatch each cluster to a fresh Claude/Codex session. Use when the user says "跑一下 todo"、"分派待办"、"清一下任务列表"、"todo 跑起来"、"看看有没有 todo"、"dispatch todos"、"run my backlog". Also handles single-todo CRUD (list / create / done).
---

# Todo 驱动

参数: $ARGUMENTS

## AI 工作项约定（创建 / 识别 todo 时执行）

- **标记**：AI 创建的工作项 todo 一律在 `create_todo` 的 `tags` 里带 `ai-work-item`（MCP 的 create_todo 没有 todoType 参数，标记以 tag 承载）。识别按双口径：返回结果的 `todoType` 为 `ai-work-item` **或** `tags` 含 `ai-work-item`，任一命中即算。
- **路由提示 tag**：`skill:<name>`（建议 worker 先调的 skill）、`cli:<claude|codex>`（路由倾向）、`family:<key>`（同族聚簇键）。
- **description 固定行**：`验收: <一句可执行的话>`——AI 创建工作项时必写；另附 `来源: <planRef 或 sessionId 摘要>`（MCP 无 activity 写入口，来源走 description）。
- **关闭必带证据**：`update_todo(id, status: "done")` 前把证据（commit hash / 测试名 / file:line）追加进 description（update_todo 的 description 是整体覆盖，先读原文再拼接）。「done」是可抽查的声明，不是随口一说。

## 流程

1. **查询** — `{{mcp_server_name}}.query_todos(status: "todo")`；可按 `priority` / `scope` / `scopeRef` 过滤。
2. **过滤** — 在返回结果里只留 AI 工作项（按上面双口径；query_todos 没有 todoType/tag 参数，过滤在结果里做）。用户明确要求跑生活类待办时才放开，放开前提示一句「这些是用户待办，确认要派 AI 跑？」。展示待派清单给用户确认。
3. **聚簇** — **不按单条派工**（单条 todo 常低于 30 分钟粒度下限）：
   - 有 `family:<key>` tag 的按 key 归簇；其余按「同族」归簇（同一 CRUD 家族 / 同一目录 / 同一模式的重复项）。
   - 单簇预估实现 **≥30 分钟**（不足则合并相邻簇）、**≤3 小时**（超则对半切）。
   - 簇数 N 上限看验收方式：验收 = 测试+编译（机器判）→ **N ≤ 8**；验收需人读 diff → **N ≤ 3**。
4. **补验收行** — 簇内有 todo 的 description 缺 `验收:` 行的（多为人创建的），派发前用 `update_todo` 补上。写不出一句可执行的验收 = 这条还不能派，留下并向用户说明。
5. **路由** — 簇内有 `cli:` tag 从 tag（不一致时从多数并说明）；无则**默认 claude**，仅当簇的规格自足（prompt 里的简报 + 文件所有权清单足以「不需要知道本仓库怎么做事、照做即可」）才派 codex。有 `skill:<name>` tag 的在 prompt 里指示 worker 先调该 skill。
6. **派发** — 逐簇：
   - 簇内各条 `update_todo(id, status: "in_progress")`
   - `launch_task(projectPath, prompt, ...)`（项目从 `scope`/`scopeRef` 推断，缺失时询问）
   - 记录 `簇(todoIds) ↔ sessionId`。
7. **收尾** — 全簇完成后汇总报告：关了哪些 todo（各带证据指针）、失败的留 pending（`update_todo` 改回 `status: "todo"`）并把失败原因追加进该条 description。

## 子命令

| 形式 | 行为 |
|---|---|
| 无参 / `dispatch` | 完整流程 |
| `list` | 仅展示待办 |
| `create <title> [--priority X] [--project P]` | `create_todo`，按「AI 工作项约定」带 tag 与固定行 |
| `done <todoId>` | 先确认证据已附进 description，再 `update_todo(status: "done")` |

## Prompt 模板（每簇 worker 收到）

> 来自 {{app_name}} Todo 系统的一簇待办（family: <key>）。
> 簇内条目（每条含 todoId / 标题 / 描述 / `验收:` 行）：<逐条列出>
> 文件所有权：本簇只改 <目录/文件清单>，簇外文件不碰。
> 开工前先复述：一句话总结任务 + 将改文件清单，复述完直接开工。
> 每完成一条即 `update_todo(id, status: "done", description: 原描述 + 证据行)`，证据 = commit hash / 测试名 / file:line；做不完的留 in_progress 并在描述里写明卡点。全部结束后向用户汇报。

## 示例

```
/ccpanes:dispatch-todos
/ccpanes:dispatch-todos dispatch --priority high
/ccpanes:dispatch-todos create "修复登录 bug" --priority high
/ccpanes:dispatch-todos done abc123
```
