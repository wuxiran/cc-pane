# Todo 驱动

查询未完成的 Todo 待办，按 Todo 生成 prompt，批量启动 Claude/Codex 实例执行。

参数: $ARGUMENTS

---

## MCP 工具

使用 `{{mcp_server_name}}` MCP 服务器的以下工具：

| 工具 | 用途 |
|------|------|
| `query_todos` | 查询待办列表 |
| `create_todo` | 创建待办 |
| `update_todo` | 更新待办状态 |
| `list_projects` | 列出可用项目 |
| `launch_task` | 启动实例 |
| `get_session_status` | 查询会话状态 |

---

## 流程

### 1. 查询待办

调用 `{{mcp_server_name}}.query_todos`：
- `status`: "todo"（未完成）
- `priority`（可选）: 从 `$ARGUMENTS` 解析（high/medium/low）
- `scope`/`scopeRef`（可选）: 按工作空间或项目筛选

展示待办列表供用户确认。

### 2. 筛选分派

用户确认要分派的 Todo（可全选或部分选择）。

对每个待选 Todo：
1. 确定目标项目（从 Todo 的 scope/scopeRef 推断，或询问用户）
2. 根据 Todo 标题和描述生成 prompt

### 3. 批量启动

对每个待分派的 Todo：
1. 调用 `{{mcp_server_name}}.update_todo`，状态改为 `in_progress`
2. 调用 `{{mcp_server_name}}.launch_task`，prompt 包含 Todo 内容
3. 记录 todoId ↔ sessionId 映射

### 4. 汇报

展示分派结果：

| Todo | 项目 | sessionId | 状态 |
|------|------|-----------|------|
| ... | ... | ... | 已启动 |

---

## 子命令

### 无参数 / `dispatch` — 查询并分派

完整执行上述流程。

### `list` — 仅查询待办

调用 `{{mcp_server_name}}.query_todos` 展示列表，不执行分派。

### `create <title> [--priority high] [--project /path]` — 创建待办

调用 `{{mcp_server_name}}.create_todo`。

### `done <todoId>` — 标记完成

调用 `{{mcp_server_name}}.update_todo`（参数: `id`, `status: "done"`）。

---

## 示例

```
/ccpanes:dispatch-todos                    # 查询未完成 Todo 并分派
/ccpanes:dispatch-todos list               # 仅列出待办
/ccpanes:dispatch-todos dispatch --priority high  # 仅分派高优先级
/ccpanes:dispatch-todos create "修复登录 bug" --priority high
/ccpanes:dispatch-todos done abc123        # 标记完成
```

---

## Prompt 模板

分派时生成的 prompt 格式：

```
## 任务来源

来自 {{app_name}} Todo 系统的待办任务。

## 任务内容

标题: {todo.title}
描述: {todo.description}
优先级: {todo.priority}

## 要求

完成上述任务。完成后告知用户。
```
