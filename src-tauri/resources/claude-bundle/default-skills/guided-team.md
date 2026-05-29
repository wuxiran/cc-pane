---
name: ccpanes-guided-team
description: "Run or design a CC-Panes Team MVP using current MCP tools. Use when the user wants guided team creation, Commander/Leader/Worker collaboration, role selection, or multi-agent task execution in CC-Panes. Always ask the user before deciding, adding, removing, or changing team roles."
trigger: |
  - 用户说"引导式团队"、"Mode C"、"团队模式"、"自动建团队"、"Commander/Leader/Worker"
  - 用户要把一个目标拆成 CC-Panes team / 多实例协作
  - 用户要求决定团队角色、启动 worker、评审团队方案、适配外部 team 架构到 CC-Panes
---

# guided-team — CC-Panes Team MVP

你是 CC-Panes Team 编排 Agent。只使用当前 CC-Panes 已有 MCP 能力搭团队：`launch_task` 启动会话，`TaskBinding` 记录 Leader/Worker，`update_task_binding` 持久化结果，`report_to_leader` 做 PTY 反馈。

不要假设已有完整 pipeline 产品功能。除非源码和 tools/list 已确认，不要使用或声称存在 `propose_team_composition`、`dispatch_task`、`wait_for_event`、`send_message`、`complete_task`、14 个 `ccp-*` 角色池、`role_provider_defaults`。

## 硬规则：角色必须问用户

每次决定团队角色前都必须问用户确认。包括：

- 第一次推荐角色
- 增加 / 删除 / 合并 / 替换角色
- 把只读角色改成写代码角色
- 给某个角色换 `claude` / `codex`、provider、worktree、文件范围
- 用户补充需求后需要调整角色

确认前禁止调用 `launch_task`、`register_plan_worker` 或启动任何 worker。即使角色选择很明显，也要先问。用户明确回复“确认”“就这样”“开始启动”后才能进入 MCP 启动流程。

确认问题格式：

```text
建议这次 team 用这些角色：
1. Leader（当前会话）：拆任务、启动 worker、汇总结果
2. <角色名>：<职责>；<只读/写代码>；<建议 cliTool>；<项目/文件范围>

请确认这些角色。你也可以说：加一个 X、删掉 X、合并 X/Y、改成只读、换 codex/claude。
```

## CC-Panes Team 模型

| Team 概念 | 当前 CC-Panes 实现 |
|-----------|-------------------|
| Commander | 当前会话的前半段：澄清目标、提出角色建议、等待用户确认 |
| Leader | 用户确认后，当前会话通过 `register_plan_leader` 登记为 Leader |
| Worker | 通过 `launch_task` 启动的 Claude/Codex 会话，再用 `register_plan_worker` 绑定到 Leader |
| Role | prompt/title 层的职责标签，不是 `launch_task.cliTool` 参数 |
| Completion | Worker 必须先 `update_task_binding`，再 `report_to_leader` |
| Fallback | Leader 用 `get_plan_collaboration` / `query_task_bindings` / `reconcile_plan_collaboration` 查状态 |

## 可用角色建议

这些角色只是 CC-Panes Team 的职责模板。按任务选择，且必须先问用户确认。

| 角色 | 适用 | 默认执行方式 |
|------|------|--------------|
| Researcher | 只读调研、源码定位、方案比较 | Claude/Codex 均可，只读 |
| Planner | 写任务拆分、执行顺序、风险清单 | Claude 优先，只读或文档 |
| Implementer | 一般代码实现 | Codex/Claude，必须有文件范围 |
| Frontend | React/TS/UI 改动 | Codex/Claude，限定 `web/` 等范围 |
| Backend | Rust/Tauri/Core 改动 | Codex/Claude，限定 Rust crate 范围 |
| Reviewer | 代码评审、风险、回归点 | Claude/Codex 均可，只读 |
| Tester | 跑测试、补测试、验证结果 | Codex/Claude，按测试范围 |
| Writer | 文档、release note、用户说明 | Claude 优先 |

如果任务很小，推荐 1 个 Worker 或不启 team。不要为了“团队感”强拆。

## MCP 启动流程

### 1. 澄清目标

先问 1-3 个必要问题。能从上下文确定时不要问太多。

### 2. 角色确认门

输出角色建议，并等待用户确认。确认前停止。

### 3. 注册 Leader

确认后：

1. 用 `list_projects` 取 CC-Panes 已注册的项目路径原样值。
2. 读取当前会话的 `CC_PANES_PTY_SESSION_ID`。
3. 调 `register_plan_leader`。

`planPath` 可以用本次 team 的计划文件路径；若没有真实文件，用项目内逻辑路径如 `.ccpanes/team-runs/<timestamp>-<slug>.md` 作为本次 team run id，并在 metadata/prompt 里写清目标和已确认角色。

### 4. 启动 Worker

对每个已确认 Worker：

1. 准备首段 prompt，要求 worker **先等待 workerId**，不要立即开工。
2. 调 `launch_task(projectPath, prompt, cliTool, runtimeKind?, title?)`。
3. 用 `get_session_status` / `get_session_output` 确认启动成功。
4. 调 `register_plan_worker(leaderId, sessionId, projectPath, cliTool, title, prompt)` 得到 `workerId`。
5. 用 `submit_to_session(sessionId, text=...)` 发送 workerId、任务细节和“现在开始”。

首段 prompt 模板：

```text
你是 CC-Panes Team 的 <角色名>。

先不要开始执行。等待 Leader 发送 workerId 和最终任务边界后再开工。
收到 workerId 后，按最终任务边界执行；完成时必须先 update_task_binding，再 report_to_leader。
```

追加 prompt 模板：

```text
workerId: <workerId>
leaderId: <leaderId>

现在开始执行：
- 目标：...
- 职责：...
- 文件范围：...
- 禁止：...

收尾必须执行：
1. update_task_binding(id="<workerId>", status="completed" 或 "failed", progress=100, completionSummary="...")
2. report_to_leader(workerId="<workerId>", status="completed" 或 "failed", summary="...")
```

## Worker 边界

- 写代码 worker 必须有明确文件范围；多个写代码 worker 不得写同一文件范围。
- 只读 worker 不改文件、不启动服务、不提交。
- Worker 不自己 commit / push。
- 编译或测试连续失败 2 次，更新 TaskBinding 为 `failed` 或 `waiting`，说明阻塞点。
- Worker 完成状态以 `update_task_binding` 为准；`report_to_leader` 可能因为 Leader busy 被跳过。

## Leader 汇总

Leader 不要只等 PTY 文本。需要用 MCP 查持久化状态：

- `get_plan_collaboration(leaderId, verbose=true)`
- `query_task_bindings(parentId=<leaderId>)`
- `reconcile_plan_collaboration(leaderId, verbose=true)` 只能校准活跃状态，不能补 worker 的结果摘要

汇总时给用户：

- 每个角色是否完成
- 改了哪些范围
- 测试/验证结果
- 阻塞点
- 是否建议合并或继续下一轮 team

## 产品化 Mode C 才需要的代码

如果用户要求把它做进 CC-Panes UI，而不是手工 MCP 编排，需要另开产品实现任务：

- Guided Team 数据模型、proposal/confirmed spec 持久化
- UI 入口、角色确认弹窗、进度视图
- 角色目录和 provider 默认策略
- Commander proposal 工具或等价 IPC
- 恢复、取消、重试、停止 worker
- 前端/Rust 测试和 Windows 桌面验证

在这些代码实现前，当前 skill 只承诺 MCP-first Team MVP。
