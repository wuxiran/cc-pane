# 61. WSL Codex 派工静默卡死：prompt 传进去了却没提交

> 2026-07-25 实测发现。派 WSL Codex worker 执行 docs/60 任务时命中，一个回车救活。
>
> 一句话：**codex 进程活着、prompt 完整、cwd 正确、YOLO 标志在，但 PTY 零输出、CPU 零占用，
> 从外部观测与"启动失败"完全无法区分。**

## 1. 现象

`launch_task(cliTool: "codex", runtimeKind: "wsl", prompt: <约 4KB 中文 prompt>)` 之后：

| 观测点 | 值 |
|---|---|
| `get_session_status` | `idle`，`lastOutputAt` **永远停在派发那一刻** |
| `get_session_output` | `{"content":"", "lineCount":0}` —— 完全空 |
| WSL 内 `ps aux` | 进程**活着**（node wrapper + codex-linux-x64 各一个），`-C /mnt/d/.../<worktree>` 正确，`--dangerously-bypass-approvals-and-sandbox` 在，prompt 作为位置参数完整可见 |
| CPU 时间 | 11 分钟后仍是 **0:00** |
| worktree | 无任何文件改动、无 commit |

**干预**：`write_to_session(sessionId, "\r")` —— 一个裸 CR。

**结果**：整段 prompt **立刻渲染出来**，状态 `idle → active`，80 秒后 worker 开始落地文件，正常干活。

即 prompt 已经进了 TUI 的输入区，**但从未被提交**；在被提交前 PTY 也不吐任何字节。

## 2. 为什么危害不小

- 外部观测（`status=idle` + 零输出 + `lastOutputAt` 不动）与「刚启动还没输出」**同形**；
- plantocodex 的软超时兜底基于 `lastOutputAt` 是否停滞 —— 这里 `lastOutputAt` 根本没动过，
  兜底逻辑会一直判成"刚起步，继续等"；
- 无人值守派工（leader 派完就去干别的）会**静默永久卡死**，leader 只有等到超时才发现，
  且第一反应必然是误判成"启动失败"（本次 leader 的第一判断就是错的）。

## 3. 代码锚点

### 3.1 prompt 作为位置参数

`cc-panes-core/src/services/terminal_service/wsl_codex.rs:445-458`

```rust
pub(super) fn append_codex_resume_args(
    codex_args: &mut Vec<String>,
    resume_id: Option<&str>,
    initial_prompt: Option<&str>,
) {
    if let Some(resume_id) = resume_id { … }
    if let Some(initial_prompt) = initial_prompt {
        codex_args.push(initial_prompt.to_string());   // ← 位置参数
    }
}
```

生成的启动脚本（`~/.cc-panes-dev/wsl-launch/codex-<sessionId>.sh:96`）末尾形如：

```
exec 'codex' … '-C' '/mnt/d/…/cc-book-wt-notify' '--dangerously-bypass-approvals-and-sandbox' '<4KB prompt>'
```

对照：同文件 :1017-1026 里 **opencode 的 prompt 明确不能走位置参数**（会被当成启动目录），
已经改成 `--prompt`。codex 这条路径是否也该换成非位置参数的传递方式，需要核实 codex CLI 的现有能力。

### 3.2 伴生异常：同一 sessionId 被重复绑定

日志（`~/AppData/Local/com.ccpanes.dev/logs/cc-panes.log`）中，同一个 sessionId 被**两个**
TerminalView 实例（`term-npuft3` / `term-b98h2o`，分属两个 paneId）反复 `mount → active.effect →
cleanup.begin → cleanup.end → mount`，随后**每分钟**刷一条：

```
cc_panes_core::repository::session_restore_repo ERROR
  Failed to insert session session_id=<该 session> err=UNIQUE constraint failed: terminal_sessions.session_id
```

锚点：`cc-panes-core/src/repository/session_restore_repo.rs:24`（`INSERT INTO terminal_sessions`，
非 upsert）+ :55（报错处）。当时该会话是 `launch_task` 默认的 `placement: "beside"` 分屏落位。

**这条与 §3.1 是否同因未验证**，但两者同时出现，且 CC-Panes 有已知的"React 19 严格模式 dev 下
useEffect 双挂载"背景（见 CLAUDE.md Known Gotchas），值得一起查。

## 4. 复现与验证方法

复现（未做最小化，以下是实际命中的组合）：

1. dev 实例，`launch_task(projectPath: <Windows 路径的 git worktree>, cliTool: "codex",
   runtimeKind: "wsl", prompt: <约 4KB 多行中文>)`，落位用默认 `beside`；
2. 立刻 `get_session_output` → 空；等 6 分钟仍空。

判定是否命中本 bug（**不要靠 status 判断**）：

```bash
# PTY 空但进程活着 = 命中
wsl.exe -d Ubuntu -- bash -lc "ps aux | grep codex | grep -v grep"
```

临时解法：`write_to_session(sessionId, "\r")`。

## 5. 待定问题（本文只记录事实，不预设结论）

1. 是 codex CLI 对超长位置参数 prompt 的行为变化，还是 CC-Panes 侧少发了一次提交事件？
   —— 需要用短 prompt（如 10 字）对照实验，本次未做；
2. 是否与落位方式相关（`beside` 分屏双绑定 vs `tab`）？—— 本次未做对照；
3. 与既有记忆「launch_task prompt 截断：旧版实例/daemon launch 走"写文件+一行指令"」
   是否同族问题；
4. 若确认需要"发一次提交"，兜底应该放在哪层：启动脚本尾部、PTY 附着后、还是 `launch_task` 返回前。

## 6. 对编排流程的直接影响（在根因修掉之前）

- 派 WSL Codex 后**必须验证它真的动了**，判据是 `get_session_output` 非空或 `lastOutputAt` 前进，
  **不能只看 `status`**；
- 软超时兜底不能只看 `lastOutputAt` 停滞，还要覆盖"`lastOutputAt` 从未前进过"这一种；
- 命中后先试 `write_to_session("\r")`，不要直接 kill 重发（重发大概率再次命中）。
