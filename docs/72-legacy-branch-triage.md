# 72 — 老分支收编判定：`git cherry` 说「未合并」不等于「还有价值」

> 2026-08 清理 13 个 worktree / 4 条未合并分支时的判定记录。
> **下次再看到这几条分支标着「未合并」时，先读本文，不要重新纠结一遍。**

## 结论速查

| 分支 | 判定 | 依据 |
|---|---|---|
| `fix-web-process-lifecycle` | **已抽取**，其余作废 | 9 文件里 main 已有 8 个更新版本；只有 `process_guard.rs` 是真缺的 |
| `feat/opencode-parity` | **已抽取**，其余作废 | 27 文件里 main 已有 24 个更新版本；只有 OpenCode 会话反查是真缺的 |
| `pr-22` | **完全被取代** | main 的 `terminalImeGuard.ts` 350 行 + 测试 451 行，均多于分支的 431/339 |
| `0111-module-registry` | **完全被取代** | main 上 `registry.ts` 193 行 / `useModulePrefsStore.ts` 127 行，均多于分支的 136/82 |

四条都**不要整分支 merge**。已抽取的两块见下文，其余可视为历史归档。

## 判定方法：三层，缺一层就会误判

这次实际踩了三个坑，每个都差点导致错误决定。

### 第 1 层：`git branch -d` 的防线在本仓库失效

本仓库是 **squash-merge 工作流**，内容已进 main 的分支，提交对象仍不是 main 的祖先，
`-d` 照样报 `not fully merged`。

→ 判断已合并要用 `git cherry origin/main <branch>`（按**内容**比，`+` = 未合并）。

### 第 2 层：`git cherry` 只看提交，看不出「能力已被更好的实现取代」

`pr-22` 被 `git cherry` 标 `+`，但 main 上那个能力的**起点就是这个 PR**
（commit `71d9010 fix: guard linux webkit ime input`），之后又迭代了 4 次
（跨 chunk 剥离、非 Linux 不清状态、粘贴后中文失效）。合并它 = 回退。

→ 对每条分支再问一句：**它改的东西 main 上现在是什么样？**
查 `git log main -- <该分支的核心文件>`，看有没有后续迭代。

### 第 3 层：比「文件是否存在」会误判，比「行数」也会

- **只比路径存在性 → 低估**：我一度断言 `0111-module-registry` 的「27 文件 main 全都有」，
  实际有 9 个是 `git diff --name-status` 里的 `A`（新增）。要用 `--name-status` 分清 A/M。
- **只比行数 → 也可能高估**：反过来，`0111-module-registry` 那 9 个「新增」文件
  在 main 上**其实都已存在且更长**（registry.ts main 193 行 vs 分支 136 行）——
  因为 main 早已合过这套工作的另外两个提交（`2a9b4ad`、`1c3ef4d`），
  只是第三个提交因 squash 而哈希不同、被 `git cherry` 标成 `+`。

→ 最终判据是**逐文件比对 main 与分支的实际内容**（存在性 + 行数 + `git log` 历史三者一起看），
不能只看任何单一信号。

## 已抽取的两块

### 1. `process_guard.rs`（来自 `fix-web-process-lifecycle`）

main 的 web-access 子进程只有 `child.kill()`——CLAUDE.md 记着「kill() 只杀直接子进程」，
宿主崩溃时 web 进程及孙子进程变孤儿占着端口。PTY 那侧早有 Job Object
（`cc-panes-core/src/pty/job.rs`），web 这侧一直没有。

抽取内容：Windows Job Object（`KILL_ON_JOB_CLOSE`）+ Unix 进程组，
以及 cc-panes-web 侧的 `with_graceful_shutdown`。

**整分支合并会造成的回退**（这是「不能整分支合」的实证）：
版本号 0.11.7 → 0.10.5、删掉 `tauri-plugin-single-instance`/`deep-link`/`socket2` 依赖、
抹掉后加的 daemon_expected 告警、`no_window_command` 换回裸 `Command`（Windows 闪黑窗）。

### 2. OpenCode 会话反查（来自 `feat/opencode-parity`）

main 已能启动 OpenCode 并传 resume 参数，但拿不到会话 id——Claude 靠发号、
Codex 靠 OSC 自报，OpenCode 两者都没有，会话只存在它自己的 SQLite 库里。

抽取内容：`opencode_session_service.rs` + `/api/opencode/sessions` +
`list_opencode_sessions` 命令 + `opencodeService.ts`，接口形态对齐既有的 codex 版。

## 抽取时的硬教训：编译过 ≠ 语义对

老分支的代码是 5 周~3 个月前写的，**它依赖的前提可能已经变了**。两次都被交叉评审抓到：

- **第 1 批**：原样复制的 web 优雅关闭调用 `TerminalService::cleanup_all()`，
  而 main 的 `AppState` 持有的是 `Arc<dyn TerminalBackend>`，该方法不在 trait 上——
  **编译直接失败**。改用 trait 的 `get_all_status + kill`，顺带在 daemon 模式下也成立。
- **第 1 批**：我抽取时丢了老分支「锁内 take、锁外等待」的真修复，
  导致 `stop()` 攥着 mutex 等 3 秒宽限期，并发的 status/start/restart 全被堵。
  **老分支里也有值得保留的东西，不能一律当旧版本丢弃。**

→ 抽取流程固定为：抽 → 适配 main 现状 → 跑验证 → **派 WSL Codex 只读评审**
（BRIEF 里点名攻击「冲突解法是否丢了原分支意图」「新旧语境是否错配」）→ 独立核实其结论 → 合并。

两批评审各抓到 3 条和 11 条，抽检的关键论断全部成立——这个环节不能省。

## 附：cargo 并发会报出源码里不存在的编译错误

各 worktree 的 `.cargo/config.toml` 用相对 `target-dir`，**所有 worktree 共享同一个 target**。
本轮实测：并发跑两个 cargo 会互相踩构建产物，报出的错误指向的代码与实际源码对不上，
看着像 CLAUDE.md 记的「幻影错误」，但那条讲的是**跨 worktree 复用**，
这里是**并发**——串行重跑即消失。判定：先确认报错标识符在本地是否存在，
存在则多半是并发污染而非幻影。
