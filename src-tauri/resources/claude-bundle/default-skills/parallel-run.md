---
name: ccpanes-parallel-run
description: Split a larger task into independent subtasks, launch them as parallel Claude/Codex sessions, poll status, and aggregate results. Use when the user says "并行跑"、"同时在多个项目"、"分头执行"、"开 N 个实例并行"、"parallel"、"fan out"、"run these together"。Skip when subtasks share files or have ordering dependencies — use one sequential session instead.
---

# 监督并行

参数: $ARGUMENTS

## 流程

### 1. 拆分

把 `$ARGUMENTS` 中的任务拆为**独立、无相互依赖**的子任务列表。每项明确：目标项目 + prompt。歧义就问用户。展示拆分方案，确认后继续。

### 2. 启动

对每条子任务调用 `{{mcp_server_name}}.launch_task`，记录所有 `sessionId`。

> Prompt > 200 字：写入 `.ccpanes/prompts/<task>.md`，prompt 改为 `Read task from '<path>' and execute it. Delete the file after reading.`

### 3. 轮询

每 30 秒：对每个 sessionId 调 `get_session_status`；状态变化时报告。所有 Exited/Idle 收敛后跳出。

### 4. 汇总

- 逐个 `get_session_output(sessionId)`
- 标注成功/失败
- 生成总结报告

## 边界

- 子任务**必须独立**——同一文件并发改会冲突。
- 同一 git repo 内并行时提醒 git 冲突风险。
- 轮询间隔 ≥ 20 秒，避免过频。
- 单个 worker 长时间 stalled 时提示用户介入。

## 示例

```
/ccpanes:parallel-run 在 projectA 和 projectB 中分别运行测试
/ccpanes:parallel-run 同时修复 auth 模块的 3 个 bug
```
