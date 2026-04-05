# 监督并行

拆分子任务，并行启动多个 Claude 实例执行，轮询状态并汇总结果。

参数: $ARGUMENTS

---

## MCP 工具

使用 `{{mcp_server_name}}` MCP 服务器的以下工具：

| 工具 | 用途 |
|------|------|
| `list_projects` | 列出可用项目 |
| `launch_task` | 启动实例 |
| `get_session_status` | 查询会话状态 |
| `get_session_output` | 读取会话输出 |

---

## 流程

### 1. 分析任务

从 `$ARGUMENTS` 中提取要并行执行的任务描述。

若描述不够具体，询问用户：
1. 要并行处理哪些子任务？
2. 在哪些项目中执行？（同一项目 or 不同项目）
3. 每个子任务的具体内容？

### 2. 拆分子任务

将任务拆分为可并行的子任务列表：
- 每个子任务应独立、无相互依赖
- 明确每个子任务的目标项目和 prompt

展示拆分方案，确认后继续。

### 3. 并行启动

对每个子任务调用 `{{mcp_server_name}}.launch_task`，记录所有 `sessionId`。

> **Prompt 长度限制**：如果某个子任务的 prompt 超过约 200 字，先将详细内容写入 `.ccpanes/prompts/<task-name>.md` 文件，然后在 prompt 中使用短引用：`Read task from '<文件路径>' and execute it. Delete the file after reading.`

### 4. 轮询监控

循环检查所有会话状态：

```
每 30 秒:
  for each sessionId:
    status = get_session_status(sessionId)
    if status changed:
      report to user
  if all completed:
    break
```

使用 `{{mcp_server_name}}.get_session_status` 检查状态（Active/Idle/Exited）。

### 5. 汇总结果

所有子任务完成后：
1. 调用 `{{mcp_server_name}}.get_session_output` 读取每个会话的输出
2. 汇总各子任务的执行结果
3. 标注成功/失败状态
4. 生成总结报告

---

## 示例

```
/ccpanes:parallel-run 在 projectA 和 projectB 中分别运行测试
/ccpanes:parallel-run 同时修复 auth 模块的 3 个 bug
/ccpanes:parallel-run    # 交互式规划并行任务
```

---

## 注意事项

- 子任务应尽量独立，避免修改同一文件导致冲突
- 同一项目中的并行任务需注意 git 冲突风险
- 轮询间隔不宜过短，建议 20-60 秒
- 若某个子任务长时间无进展，提醒用户介入
