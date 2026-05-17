---
name: ccpanes-fork-session
description: Summarize the current conversation context and spawn a new Claude/Codex session in the same project to continue down a branching direction. Use when the user says "分叉"、"开个新实例继续"、"fork 这个对话"、"另开个窗口试试"、"branch off"、"clone this context"、"split into parallel exploration". Inherits a compressed context summary, not the full transcript.
---

# 分叉对话

参数: $ARGUMENTS

## 流程

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

4. **启动新实例** — `{{mcp_server_name}}.launch_task`：
   - `projectPath`：当前项目（从环境推断或问用户）
   - `prompt`：**短引用** `Read the task description from '<绝对路径>' and execute it. Delete the file after reading.`
   - `title`（可选）：描述分叉方向

   > 不要把完整摘要塞进 `prompt` 参数 —— 长 prompt 会让终端黑屏。始终用"写文件 + 短引用"模式。

5. **报告** — taskId / sessionId / 继承摘要 / 分叉方向。

## 示例

```
/ccpanes:fork-session 尝试用另一种算法实现排序
/ccpanes:fork-session 新实例处理前端，我继续处理后端
```
