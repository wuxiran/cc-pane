# 修复交接件 · 依据你自己的发版审核

你的 9 条我抽检了 #5 / #2 / #9，**全部成立**。#9 正是我在 BRIEF 里让你找的
「第 5 处拆分残留」——我合并时只删了 import，没删 helpers 里的重复定义。

现在请**实施修复**。这一轮你可以改代码。

工作目录：`/mnt/d/04_workspace_rust/cc-book-merge`（分支 `main`）

## 必修（发版阻断）

### 1. #5 Unix nice 当成绝对值（真 bug，最高优先级）

`resource_policy.rs:78` 的函数叫 `nice_increment`、注释写"增量"，
但 `pty/mod.rs:265` 的 `setpriority(PRIO_PROCESS, pid, increment)` 第三参是**绝对值**。

CC-Panes 若以 nice>5 启动，子进程反而被**提权**；普通用户得 EPERM，
整个降优先级策略静默失效——正是这批要解决的问题本身。

改法自定（读当前 nice 再加、或把语义改成绝对值并同步命名/注释），但要求：
- 命名、注释、实际语义三者一致，别再留同名不同义
- 失败路径仍只 warn 不阻断会话（既有约定）

### 2. #2 后台会话退出时尾部输出丢失/乱序

`TerminalView.tsx:686` 的 `handleSessionExit` 直接 writeln 退出提示，
**没有先 drain 隐藏缓冲**。后台会话最后一段输出会出现在 "Process exited" 之后；
若退出触发 reset()，尾部直接丢弃。

修复后补一条**组合时序**测试（现有测试分别覆盖隐藏回放和退出提示，缺两者组合）。

### 3. #9 拆分残留：helpers 里的重复定义

`terminalViewHelpers.ts:63/67/106` 的 `resolveCliTool` / `resolveRuntimeKind` /
`notifySessionClaimed` 与 `terminalLaunchIdentity.ts` / `terminalSessionNotices.ts`
重复。删 helpers 那份，保留专门模块。

注意 `notifySessionClaimed` 各带一份 cooldown Map——两套冷却状态会让同一会话
重复弹提示。删的时候确认没有别的调用方从 helpers 导入。

### 4. #1 后台输出缓冲的内存上界（你标"高"的第一条）

请先复述一下你的完整结论（输出被截断了我只看到后半段），再决定修法。
`terminalHiddenWriteBuffer.ts` 注释写着"积压超过上限时立刻整块 flush，让内存有界"，
但你说积压会转移到 Promise/xterm 写队列、内存仍可无限增长。
如果属实，这条是发版阻断；如果 flush 已经把数据交出去了，说明只是转移到 xterm 内部，
那要评估 xterm 侧是否有界。

## 需要你判断后再决定

### #3 Files 视图绕过调用方布局
`editorTabActions.ts:68`、`useOrchestratorListener.ts:336`

如果属实，本批"谁调用就落谁布局"的核心目标在 Files 路径上没达成。
请判断：这是本批引入的回归，还是既有行为？
- 本批回归 → 修
- 既有行为且本批没变坏 → 不修，登记为独立项并说明

### #4 alt-screen 根因未修
你说 docs/73:92 明确要求"先落可关闭剥离的设置"，而本批只加了手动恢复。

请判断：**当前状态会不会让用户比修改前更糟**？
- 会 → 说清怎么更糟，我考虑回退这部分
- 不会（只是没修完） → 不动，我在 CHANGELOG 里如实写"缓解而非根治"，
  剩余工作登记进 docs/73

### #7 嵌套会话归属依赖 HashMap 迭代顺序（你标存疑）
你给了验证方法（构造 A→B 嵌套根，以 [A,B]、[B,A] 两种顺序调用求一致）。
请**实际跑一次这个验证**再下结论，别停在静态推理。

## 不修（本轮明确排除）

- **#6 PolicyOutcome 未回传前端**：属于可观测性增强，不是正确性缺陷。
  策略失败时会话仍正常启动，只是 UI 不知情。登记为下一批（docs/71 剩余 6 批之一）。
- **#8 其余三处松动基线**（Panel/TabBar/SharedMcpSection）：非本批造成，
  本批只负责自己动过的两处。顺手收紧会让发版 diff 混入无关改动。

## 纪律

- 改动过程中**不要跑测试**，最后一次性跑：
  ```
  cargo fmt --all -- --check
  npx tsc --noEmit
  cargo clippy --workspace -- -D warnings      # 不带 --all-targets
  cargo test -p cc-panes-core
  cargo test --manifest-path src-tauri/Cargo.toml
  npx vitest run --maxWorkers=3 web/components/panes web/stores
  ```
- **cargo 不要并发跑**（多 worktree 共享 target-dir，并发会报源码里不存在的错误）
- `--all-targets` 在基线上就有 21 个既有 lint，不要去动
- **不要提交 git**，不要 bump 版本号
- 改动处写清 why

## 完成后

写 `.claude/review-0118-release/FIX-REPORT.md`：每条改了什么、为什么、文件行号；
#3/#4/#7 的判断结论与依据；未修项写清原因；测试结果如实贴（失败就贴失败）。
