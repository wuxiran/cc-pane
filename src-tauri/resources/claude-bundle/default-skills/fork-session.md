---
name: ccpanes-fork-session
description: Fork this conversation into a new session to try another direction, with full history or a context summary. Use when the user says "分叉"、"开个新实例继续"、"fork 这个对话"、"另开个窗口试试"、"branch off"、"clone this context"、"split into parallel exploration". Prefers a native fork; falls back to a compressed context summary.
---

# 分叉对话

参数: $ARGUMENTS

## 先选方式

| 方式 | 什么时候用 | 新会话拿到什么 |
|---|---|---|
| **原生分叉** | 目标 CLI 是 claude 或 codex，运行环境不是 ssh，且查得到源会话 ID | 源会话的完整历史 |
| **摘要分叉** | 其它情况，或要换一个 CLI 继续 | 你写的上下文摘要 |

### 原生分叉

1. **确定分叉方向** — 从 `$ARGUMENTS` 提取；缺失时询问用户。
2. **找到源会话 ID** — `{{mcp_server_name}}.list_launch_history(projectPath)`，取 `projectId` 等于环境变量 `CC_PANES_LAUNCH_ID` 的那条的 `resumeSessionId`。查不到就改用摘要分叉，不要猜 ID。
3. **派发** — `{{mcp_server_name}}.dispatch_task`：
   - `projectPath`、`cliTool`、`runtimeKind`：与源会话一致
   - `forkSessionId`：上一步的 ID
   - `prompt`：分叉方向，一两句话即可（历史已经继承，不必复述上下文）
   - `title`（可选）：描述分叉方向
4. **报告** — bindingId / sessionId / 分叉方向，并说明新会话带着完整历史、原会话不受影响。

### 摘要分叉

1. **总结当前上下文** — 压缩为结构化摘要：正在处理的文件/模块、已完成修改、当前问题或决策点、关键代码片段或架构决策。
2. **确定分叉方向** — 从 `$ARGUMENTS` 提取；缺失时询问用户（尝试另一实现方案？并行子任务？）。
3. **写任务文件** — `Write` 到 `.ccpanes/prompts/fork-<timestamp>.md`，格式：

   ```md
   # Fork 任务

   ## 上下文继承

   {摘要}

   ## 你的任务

   {分叉方向}
   ```

4. **派发新实例** — `{{mcp_server_name}}.dispatch_task`：
   - `projectPath`：当前项目（从环境推断或问用户）
   - `cliTool`：用户指定的目标工具；未指定时沿用当前项目兼容配置
   - `prompt`：**短引用** `Read the task description from '<绝对路径>' and execute it. Delete the file after reading.`
   - `title`（可选）：描述分叉方向

   > 不要把完整摘要塞进 `prompt` 参数 —— 长 prompt 会让终端黑屏。始终用"写文件 + 短引用"模式。

5. **报告** — bindingId / dispatchTaskId / sessionId / 继承摘要 / 分叉方向。

## 示例

```
/ccpanes:fork-session 尝试用另一种算法实现排序
/ccpanes:fork-session 新实例处理前端，我继续处理后端
```
