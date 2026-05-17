---
name: ccpanes-dispatch-todos
description: Query pending todos from {{app_name}}, generate a prompt per todo, and dispatch them to fresh Claude/Codex sessions in batch. Use when the user says "跑一下 todo"、"分派待办"、"清一下任务列表"、"todo 跑起来"、"看看有没有 todo"、"dispatch todos"、"run my backlog". Also handles single-todo CRUD (list / create / done).
---

# Todo 驱动

参数: $ARGUMENTS

## 流程

1. **查询** — `{{mcp_server_name}}.query_todos(status: "todo")`；可按 `priority` / `scope` / `scopeRef` 过滤。展示给用户确认。
2. **筛选 + 推断目标** — 对每条选中的 todo：项目从 `scope`/`scopeRef` 推断，缺失时询问；prompt 由 title + description + priority 拼装。
3. **批量启动** — 逐条：
   - `update_todo(id, status: "in_progress")`
   - `launch_task(projectPath, prompt, ...)`
   - 记录 `todoId ↔ sessionId`。
4. **汇报** — 输出"todo / project / sessionId / status"表。

## 子命令

| 形式 | 行为 |
|---|---|
| 无参 / `dispatch` | 完整流程 |
| `list` | 仅展示待办 |
| `create <title> [--priority X] [--project P]` | `create_todo` |
| `done <todoId>` | `update_todo(status: "done")` |

## Prompt 模板（每个 worker 收到）

> 来自 {{app_name}} Todo 系统的待办。标题: <title>；描述: <description>；优先级: <priority>。请完成后告知用户。

## 示例

```
/ccpanes:dispatch-todos
/ccpanes:dispatch-todos dispatch --priority high
/ccpanes:dispatch-todos create "修复登录 bug" --priority high
/ccpanes:dispatch-todos done abc123
```
