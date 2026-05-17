---
name: ccpanes-browse-sessions
description: Inspect live {{app_name}} terminal sessions — list active tabs, read recent output, look up launch history or past Claude sessions. Use when the user asks "看下其他实例"、"那个会话跑到哪了"、"另一个窗口的输出"、"上次启动了什么"、"列出会话"、"check the other tab"、"what did session X say"、"show launch history". For resuming a session, hand off to launch-task.
---

# 会话浏览

参数: $ARGUMENTS

## 决策树（按用户问的内容选工具）

| 用户在问什么 | 调用 |
|---|---|
| 当前有哪些活跃会话 | `list_sessions` |
| 某会话当前状态（Active/Idle/Exited） | `get_session_status(sessionId)` |
| 某会话最近输出/错误 | `get_session_output(sessionId, lines: 100-500)` |
| 历史启动过什么任务 | `list_launch_history(projectPath?, limit)` |
| 找到一个想 resume 的 Claude 会话 | `list_claude_sessions(projectPath?)` → 然后交给 launch-task 的 resume |

## 子命令快捷映射

```
list / 无参         → list_sessions（表：sessionId / status / lastOutputAt）
status <id>         → get_session_status
read <id> [lines]   → get_session_output（默认 100）
history [path]      → list_launch_history
claude-sessions     → list_claude_sessions
```

## 典型用途

1. 监控并行 worker：`list` → 看哪些 Idle → `read` 看结果
2. 调试失败：`history` 找到 sessionId → `read` 看错误
3. 恢复中断：`claude-sessions` → 拿到 sessionId → `/ccpanes:launch-task resume <id>`

读 output 时高亮错误行（包含 "error" / "panic" / "FAIL"），给用户摘要而不是全文。
