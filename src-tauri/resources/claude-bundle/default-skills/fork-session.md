# 分叉对话

总结当前对话上下文，在同一项目中启动新的 Claude 实例继承上下文走分支方向。

参数: $ARGUMENTS

---

## MCP 工具

使用 `{{mcp_server_name}}` MCP 服务器的以下工具：

| 工具 | 用途 |
|------|------|
| `launch_task` | 启动新实例 |
| `get_session_status` | 确认启动状态 |

---

## 流程

### 1. 总结当前上下文

回顾当前对话中的关键信息：
- 正在处理的文件和模块
- 已完成的修改
- 当前面临的问题或决策点
- 相关的代码片段和架构决策

将以上内容压缩为一段结构化的上下文摘要。

### 2. 确定分叉方向

从 `$ARGUMENTS` 中提取新实例应该探索的方向。

若未指定，询问用户希望新实例做什么（如尝试不同的实现方案、处理并行子任务等）。

### 3. 写入任务文件

将上下文摘要和分叉方向写入项目目录下的 `.ccpanes/prompts/fork-<timestamp>.md`：

```md
# Fork 任务

## 上下文继承

以下是从父对话继承的上下文：

{上下文摘要}

## 你的任务

{分叉方向/具体任务描述}
```

使用 Write 工具将上述内容写入文件。

### 4. 启动新实例

调用 `{{mcp_server_name}}.launch_task`：
- `projectPath`: 当前项目路径（从环境推断或询问用户）
- `prompt`: **短引用指令**，格式：`Read the task description from '<文件绝对路径>' and execute it. Delete the file after reading.`
- `title`（可选）: 描述分叉方向的标签名

> **重要**：不要将完整上下文内容直接放入 prompt 参数。长 prompt 会导致终端黑屏。始终使用"写文件 + 短引用"模式。

### 5. 报告

告知用户新实例已启动，包含：
- 新实例的 taskId/sessionId
- 继承的上下文摘要
- 分叉方向说明

---

## 示例

```
/ccpanes:fork-session 尝试用另一种算法实现排序
/ccpanes:fork-session 在新实例中处理前端部分，我继续处理后端
/ccpanes:fork-session    # 交互式确定分叉方向
```
