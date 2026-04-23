# 会话浏览

列出 {{app_name}} 中所有终端标签页的状态，读取指定标签的上下文和输出内容。

参数: $ARGUMENTS

---

## MCP 工具

使用 `{{mcp_server_name}}` MCP 服务器的以下工具：

| 工具 | 用途 |
|------|------|
| `list_sessions` | 列出所有活跃终端会话 |
| `get_session_status` | 查询指定会话状态 |
| `get_session_output` | 读取会话输出内容 |
| `list_launch_history` | 查询启动历史 |
| `list_claude_sessions` | 查询 Claude 历史会话 |

---

## 子命令

解析 `$ARGUMENTS`，执行对应操作：

### `list` / 无参数 — 列出所有活跃会话

调用 `{{mcp_server_name}}.list_sessions`，以表格展示：

| 列 | 说明 |
|----|------|
| sessionId | 会话 ID |
| status | Active / Idle / WaitingInput / Exited |
| lastOutputAt | 最后输出时间 |

### `status <sessionId>` — 查看会话详细状态

调用 `{{mcp_server_name}}.get_session_status`（参数: `sessionId`）。

### `read <sessionId> [lines]` — 读取会话输出

调用 `{{mcp_server_name}}.get_session_output`：
- `sessionId`: 目标会话
- `lines`（可选）: 返回最近 N 行，默认 100

展示输出内容，高亮错误信息。

### `history [projectPath]` — 查看启动历史

调用 `{{mcp_server_name}}.list_launch_history`：
- `projectPath`（可选）: 按项目筛选
- `limit`: 默认 20

展示历史记录，包含 prompt 摘要和时间。

### `claude-sessions [projectPath]` — 查看 Claude 历史会话

调用 `{{mcp_server_name}}.list_claude_sessions`：
- `projectPath`（可选）: 按项目筛选
- `limit`: 默认 20

---

## 示例

```
/ccpanes:browse-sessions                       # 列出所有活跃会话
/ccpanes:browse-sessions list                  # 同上
/ccpanes:browse-sessions status abc123         # 查看会话状态
/ccpanes:browse-sessions read abc123 50        # 读取最近 50 行输出
/ccpanes:browse-sessions history               # 查看启动历史
/ccpanes:browse-sessions history /path/to/proj # 按项目筛选
```

---

## 典型用途

1. **监控其他实例进度**: list → read 查看输出
2. **调试失败任务**: history 找到会话 → read 查看错误
3. **恢复中断会话**: claude-sessions 找到会话 ID → 用 launch-task 的 resume 功能恢复
