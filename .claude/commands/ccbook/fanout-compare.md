---
name: fanout-compare
description: 同一个任务/plan 并行派给 N 个 worker（各自独立 git worktree），完成后对比 N 份实现挑赢家合并，输家清理。Use when 用户说"fan out"、"多派几份对比"、"同时试两种方案/两个模型"、"哪个做得好用哪个"。Skip when 子任务内容不同（那是 parallel 的活）。
---

# fanout-compare — 同题 N 卷：并行实现对比

> **会话状态判读、停手规则与收尾字段以 [`docs/65 · Skill 观测契约`](../../../docs/65-skill-observation-contract.md) 为准**，本文不再复述。
> 三条最常踩的：`idle` + `turnSeq: 0` **且 PTY 零输出** = prompt 未提交（发裸 CR，**不要 kill 重发**）——
> 三个条件缺一不可；**PTY 有输出时多半是在等你选**，此时发 CR 会盲选一项；
> `status` 单独不可信，判活要看 `lastOutputAt` 停滞 + 进程存活；
> 动手写之前先核身份——`$CC_PANES_LAUNCH_ID` 必须等于所连 MCP URL 里的 `launchId`，不等即串台。

你是 Fan-out 编排 Agent。把**同一个** prompt/plan 派给 N 个 worker，每个在独立 worktree 里实现，全部完成后对比产出、用户挑赢家、合并赢家、清理输家。

> 骨架复用 [`/ccbook:plantocodex`](plantocodex.md)：leader/worker 注册、监控、软超时、worktree 隔离模式的增量步骤全部沿用，本文只写 fan-out 特有的部分。

---

## 适用性收窄（先读）

fan-out 采样唯一常态合法的用途是**能力标定**：换模型 / CLI 大版本后能力边界重新变未知——拿 1~2 个标准样题（标定夹具）干跑对比，相当于给 prompt 做回归测试。日常想要多视角意见 → 走 [`/ccbook:planreview`](planreview.md)（评审强制异模型，成本远低于 N 份全量实现）。下面「何时用」的其余场景（方案 A/B、冗余抽卡）保留为例外场景：动手前必须把 N 份编译/磁盘成本报给用户并确认。

---

## 何时用 / 何时不用

**用**：
- 任务有多种合理解法，想并行试再挑（架构方案 A/B、两种重构路径）
- 想对比不同模型/CLI 的实现质量（同 prompt，一份派 codex 一份派 claude）
- 一次成功率存疑的难题，用冗余换质量

**不用**：
- 子任务内容不同 → `/ccbook:parallel`（分工，不是对比）
- 任务简单、一个 worker 大概率一次做对 → 直接 `/ccbook:plantocodex`
- 磁盘/编译成本无法接受（见护栏）

## 护栏（先于一切检查）

1. **N ≤ 3**。超过 3 份对比收益急剧递减，成本线性上涨。默认建议 N=2。
2. **成本预警（必须先告知用户再动手）**：每个 worktree 是一整套环境——
   - Node 项目：N × node_modules 安装（分钟级 + GB 级）
   - **本仓库（Rust workspace）尤其恶劣**：共享 target-dir 会并行锁死，独立 target-dir 是 N × 全量编译，target 实测 22 万文件级别——**跑之前必须把这笔账报给用户**
   - watcher/端口 × N（`vite.config.ts` 的 `server.watch.ignored` 已知坑同样适用）
3. 用户确认成本后才进入 Phase 1。

---

## 执行步骤

### Phase 0：定 N 与变体维度

`AskUserQuestion`：N 取几？对比维度是什么——
- **同模型多卷**（纯冗余抽卡）：N 份全同 cliTool
- **异模型对比**：如 try-1 派 codex、try-2 派 claude（cliTool 不同，prompt 相同）

### Phase 1：建 N 个 worktree + 注册

对每个 `i ∈ 1..N`，执行 plantocodex「worktree 隔离模式·派发前增量」：

```
git -C <主仓库> worktree add ../<repo>@try-<i> -b try-<i>/<slug>
拷贝 .env 清单（同隔离模式约定）
mcp__ccpanes__add_project_to_workspace(workspaceName, projectPath: <try-i 绝对路径>)
```

### Phase 2：注册 leader + 派发 N 份

- `register_plan_leader` 一次（同 plantocodex Phase 2）
- 对每个 i：`launch_task(projectPath: <try-i>, cliTool: <按 Phase 0>, prompt: <同一份，含收尾上报要求>)` → `register_plan_worker` → 记 `<workerId-i>`
- **prompt 必须逐份填入各自的 workerId**，其余字节完全相同（对比才公平）

### Phase 3：监控到全部完成（barrier）

沿用 plantocodex Phase 5（PTY 自动反馈 + 软超时表），差异：
- 收齐 **N 份** report 才进 Phase 4；先完成的 worker 不动它的 worktree
- 某份超时/失败：`AskUserQuestion` 给用户选「等 / kill 该份并以 N-1 继续 / 全部中止」

### Phase 4：对比

对每个 try-i：

```
git -C <try-i> diff --stat <base-branch>
git -C <try-i> diff <base-branch>        # 关键文件精读
（可选）在各 worktree 内跑同一组测试/lint，记录通过率
```

产出**对比表**：改动规模 / 实现思路差异 / 测试结果 / 明显缺陷，各附一句评价。

### Phase 5：挑赢家

`AskUserQuestion`：选项 = try-1..N（各带一行摘要）+ 「都不要，全部弃置」。leader 可标注推荐项，但**用户拍板**。

### Phase 6：合并赢家 + 清理输家

1. 赢家：主仓库 merge / cherry-pick 该分支（不主动 commit 之外的动作，等用户确认）
2. 输家（含"都不要"时的全部）：脏树无需保留 → `git worktree remove <try-i>` + `git branch -D try-<i>/<slug>`（未合并分支用 `-D`，先向用户复述哪些将被删除）
3. 提醒用户在 CC-Panes UI 移除 N 个（或 N-1 个）项目节点
4. 走 [finish-work](finish-work.md) 的「worktree 收尾」检查

---

## 反模式

- ❌ N > 3，或不报编译/磁盘成本就开干
- ❌ 各份 prompt 内容不同（除 workerId）→ 对比失效，且那是 parallel 的场景
- ❌ 挑完赢家忘清理输家 worktree → 磁盘孤儿 + 项目列表污染
- ❌ 自动合并"leader 认为最好的" → 挑赢家必须用户拍板
- ❌ 先完成的 worker 继续加活 → barrier 之前所有 worktree 冻结
