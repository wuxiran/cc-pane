---
name: plan2codexwsl
description: 在 WSL 中运行 Codex 执行 plan —— plantocodex 的 WSL 特化入口：已注册路径、runtimeKind、WSL 路径转换。要做 plan 同行评审请用 planreview。
trigger: |
  - 用户要把 plan 派给 WSL 里的 Codex 执行："在 WSL 跑 codex"、"WSL Codex 实现这个 plan"
  - plantocodex 流程中目标环境是 WSL，需要路径转换 / 项目注册细节
  不触发：plan 评审（→ /ccpanes:planreview）、本地 Codex 执行（直接 /ccpanes:plantocodex）
---

# plan2codexwsl — 在 WSL 运行 Codex 执行 plan

本 skill 是 [`/ccpanes:plantocodex`](plantocodex.md) 的 **WSL 环境特化入口**：完整的 plan → Codex 执行流程（leader/worker 注册、prompt 模板、监控、收尾）全部按 plantocodex 走，本文只补 WSL 特有的三件事。

> **职责边界**：本 skill 管"在 WSL **执行**"。要找 Codex **评审** plan（不改代码、用户拍板、重写 plan）→ [`/ccpanes:planreview`](planreview.md)，它同样支持 reviewer 跑 WSL。

---

## WSL 特有事项

### 0. 派发前先过规格自足关

派 WSL Codex 同样先走 plantocodex 的「拆分判定与 CLI 路由」节，其中两条在 WSL 场景加倍生效：

- **规格自足才可派 Codex**：简报 + 文件所有权清单 + 契约必须写到「照做即可」——WSL 侧排障成本更高，规格不自足**禁派**。
- **WSL Codex 守则**：prompt 未提交假死 → 发裸 CR，不要 kill 重发；启动前确认 WSL 内 codex 是原生 ELF（`type -a codex` 第一条不能是 `/mnt/` 下的 `.exe`）。

### 1. projectPath 必须用 cc-panes 已注册的路径原样

先 `mcp__ccpanes__list_projects` 拿到实际登记的字符串（UNC `\\wsl.localhost\Ubuntu\...` 或 `/mnt/...` 都可能存在，挑已注册那条），**原样**传给 `dispatch_task`，再配 `runtimeKind: "wsl"`：

```
mcp__ccpanes__dispatch_task(
  projectPath: <list_projects 中已注册的路径原样>,
  cliTool: "codex",
  runtimeKind: "wsl",
  title: "Codex executor (WSL): <plan 简短描述>",
  prompt: <plantocodex 的 Codex Prompt 模板，路径按下表转换>
)
```

- ❌ 自己拼 `/mnt/...` 传给 `projectPath` → 不匹配登记路径，启动失败
- 项目没注册 → 先 `add_project_to_workspace(workspaceName, projectPath)`

### 2. prompt 文本里的路径要转成 WSL 形式

**只有 prompt 文本里的路径**需要转换（`projectPath` 参数不转）：

| 输入 | 转换后 |
|------|--------|
| `C:\Users\foo\.claude\plans\x.md` | `/mnt/c/Users/foo/.claude/plans/x.md` |
| `D:\code\erp\docs\spec.md` | `/mnt/d/code/erp/docs/spec.md`（盘符全部小写） |
| `D:\路径 含空格\plan.md` | `/mnt/d/路径 含空格/plan.md`（独立行/代码块包路径，别裸贴在句子里） |
| `\\wsl.localhost\Ubuntu\home\foo\proj` | `/home/foo/proj` |
| `\\wsl$\Ubuntu\mnt\d\code` | `/mnt/d/code` |
| 已经是 `/home/...` 或 `/mnt/...` | 原样使用 |
| Windows junction / 符号链接 | WSL 里跑 `wslpath -u "<windows-path>"` 让系统转，比手写靠谱 |

### 3. WSL 内的 MCP 回连

WSL 内 Codex 的 `ccpanes` MCP 工具（`update_task_binding` / `report_to_leader`）依赖 orchestrator 可达：

- **mirrored 网络**（`~/.wslconfig` 有 `networkingMode=mirrored`）：回环直达，orchestrator 绑定模式 auto/loopback 均可
- **NAT 网络**：MCP URL 注入的 `127.0.0.1` 在 WSL 内不可达，worker 的收尾上报会失败——此时依赖 leader 软超时 + `get_session_output` 兜底（见 plantocodex Phase 5）

---

## 完整流程去哪看

| 你要做的事 | 去处 |
|-----------|------|
| leader/worker 注册、Codex prompt 模板、软超时监控、收尾 | [`/ccpanes:plantocodex`](plantocodex.md)（launch 参数按本文第 1 节替换） |
| plan 同行评审（reviewer 可跑 WSL） | [`/ccpanes:planreview`](planreview.md) |
| dispatch_task 通用排障（卡住、恢复、PTY 交互） | [`/ccpanes:launch-task`](launch-task.md) |
