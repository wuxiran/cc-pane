# 交叉评审请求 · 老分支「逐条抽取独有价值」第 1 批

你是**独立评审人**。只读评审，**不要改任何代码**。产出问题清单。

仓库根：`/mnt/d/04_workspace_rust/cc-book`（WSL 路径）。
待评审改动在 worktree：`/mnt/d/04_workspace_rust/cc-book-wt-extract`（分支 `extract/process-guard`）。
diff 已导出到 `.claude/review-extract/process-guard.diff`（408 行，含完整新增文件）。

## 背景：为什么是「抽取」而不是「合并分支」

仓库积了 4 条未合并老分支（3 个月~8 天）。原计划整分支合并，探查后发现
**至少 3 条已被 main 超越**，整分支合会造成回退：

- `pr-22`（Linux IME 去重）：main 已有 350 行 `terminalImeGuard.ts`，起点就是这个
  PR（commit 71d9010），之后又迭代 4 次。合并 = 回退
- `feat/opencode-parity`：main 的 `opencode.rs` 已 1121 行（分支 761 行），4 次后续迭代
- `0111-module-registry`：27 个文件 main 全都有
- `fix-web-process-lifecycle`：9 文件 main 已有 8 个更新版本

所以改为**只抽取 main 真正缺失的部分**。本批是第 1 块：`process_guard.rs`。

## 本批改了什么

从 `fix-web-process-lifecycle`（基线停在 0.10.5）抽出 `process_guard.rs`，接进
main 当前的 `web_access_lifecycle.rs`：

- Windows：子进程挂进 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job Object
- Unix：独立进程组 + killpg
- `attach` 失败即杀子进程并让启动失败
- `stop()` 从裸 `child.kill()` 改为「request_terminate → 3s 宽限 → force_kill」

动机：main 上 web-access 子进程只有 `child.kill()`，而 CLAUDE.md 记着
「kill() 只杀直接子进程」。宿主崩溃时 web 进程及孙子进程变孤儿，端口被占。
PTY 那侧早有 Job Object（`cc-panes-core/src/pty/job.rs`），web 这侧一直没有。

## 请重点攻击

1. **`WebAccessProcess` 的字段顺序**。我在注释里断言「Rust 按声明序 drop，
   `child` 先于 `guard`，所以 Windows 上 job handle 关闭发生在最后」。
   **这个断言对吗？** 顺序错了会怎样（job 先关 = 子进程被内核杀掉，`child.wait()`
   拿到的是什么）？有没有更稳妥的写法而不是依赖字段顺序？

2. **`stop()` 的 3s 宽限循环**。`try_wait()` 轮询 + 50ms sleep：
   - 会不会在 UI 线程上造成可感知卡顿（`stop()` 在应用退出路径也会调用）？
   - `try_wait()` 返回 `Err` 时我直接 break 去强杀，合理吗？
   - Unix 上 `request_terminate` 发 SIGTERM 后子进程忽略信号会怎样？

3. **Windows Job Object 与已有 PTY Job 的相互作用**。一个进程只能属于一个 job
   （Win7 前）/ 可嵌套（Win8+）。web 子进程如果自己又去 spawn PTY（它会——
   cc-panes-web 提供远程终端），两层 Job 会不会打架？被内层 job 接管后
   外层 KILL_ON_JOB_CLOSE 还有效吗？

4. **`attach` 失败即 fail 启动**是否过激？有没有场景（受限权限、容器、
   已在别的 job 里）会让 `AssignProcessToJobObject` 正常失败，从而把本来能用的
   Web 功能变成完全不可用？

5. **抽取是否漏了东西**。原分支的 `web_access_lifecycle.rs` 还改了别的（我判定
   那些是 main 更新的部分，不该带过来）。请核对
   `git diff main:src-tauri/src/services/web_access_lifecycle.rs fix-web-process-lifecycle:src-tauri/src/services/web_access_lifecycle.rs`，
   看有没有**真正的修复**被我当成「旧版本」误丢了。

6. 有没有更该改而没改的地方——比如 daemon 子进程（`terminal_daemon_lifecycle.rs`
   spawn 的那个）是不是也缺同样的兜底？

## 输出格式

按严重度排序，每条给 `文件:行` + 问题 + **具体失败场景**（什么输入/状态 → 什么错误结果）。
拿不准的标「存疑」并给验证方法。注意：**Windows 特有行为你在 WSL 里验不了**，
这类只做静态推理并明确标注，不要假装验证过。

没问题的部分直接跳过，不用夸。方向错了就直说。
