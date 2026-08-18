---
name: ccpanes-parallel-run
description: Split a larger task into independent subtasks, dispatch them to parallel compatible CLI sessions, poll status, and aggregate results. Use when the user says "并行跑"、"同时在多个项目"、"分头执行"、"开 N 个实例并行"、"parallel"、"fan out"、"run these together"。Skip when subtasks share files or have ordering dependencies — use one sequential session instead.
---

# 监督并行

参数: $ARGUMENTS

## 流程

### 1. 拆分

把 `$ARGUMENTS` 中的任务拆为**独立、无相互依赖**的子任务列表。每项明确：目标项目 + prompt。歧义就问用户。展示拆分方案，确认后继续。

拆分判定（是非题，先算再拆）：

- **值不值得扇出**：能列出 **≥6 个独立可交付项**，且做完任一项不需要读另一项的产出，才值得扇出；不满足 → 单 agent 顺序做（**N=1 是合法答案**）。
- **按同族聚簇**：同一脚本 / 同一模式的项目归一簇派工，不按单项派；单簇预估 **≥30 分钟**（不足合并相邻簇）、**≤3 小时**（超则对半切）。
- **N 上限看验收方式**：验收 = 测试/脚本机器判 → **N ≤ 8**；验收需人读输出 → **N ≤ 3**。编译型 worker 仍受下方「边界」的 ≤2 更严上限约束，两者取小。

### 2. 启动

对每条子任务调用 `{{mcp_server_name}}.dispatch_task`，记录每项的 `bindingId`、`dispatchTaskId`、`sessionId` 和目标 CLI。

> Prompt > 200 字：写入 `.ccpanes/prompts/<task>.md`，prompt 改为 `Read task from '<path>' and execute it. Delete the file after reading.`

### 3. 轮询

每 30 秒：对每个 `bindingId` 调 `get_task_dispatch`，并对每个 `sessionId` 调 `get_session_status`；状态变化时报告。没有 MCP 的目标以 session 状态和输出为准。所有 Exited/Idle 收敛后跳出。

### 4. 汇总

- 逐个 `get_session_output(sessionId)`
- 标注成功/失败
- 生成总结报告

## 边界

- 子任务**必须独立**——同一文件并发改会冲突。
- 同一 git repo 内并行时提醒 git 冲突风险。
- 代码型/编译型 worker 默认 ≤2 个——Rust/Java 等编译进程吃满 CPU+内存，多 worker 同时 `cargo build` / `mvn package` 会爆。更高并发需手动控制。
- 轮询间隔 ≥ 20 秒，避免过频。
- 单个 worker 长时间 stalled 时提示用户介入。

## 示例

```
/ccpanes:parallel-run 在 projectA 和 projectB 中分别运行测试
/ccpanes:parallel-run 同时修复 auth 模块的 3 个 bug
```
