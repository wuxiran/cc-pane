# 发版前审核 · 0.11.8 并行窗口工作统一收口

你是**独立评审人**。只读评审，**不要改任何代码**。产出问题清单。

仓库根：`/mnt/d/04_workspace_rust/cc-book`（WSL 路径）
待审代码在 `/mnt/d/04_workspace_rust/cc-book-merge`（分支 `main`，领先 `origin/main` 6 个提交）
diff 见 `.claude/review-0118-release/consolidated.diff`（4231 行 / 51 文件 / +2811 −331）

## 这批是怎么来的（重要背景）

三个并行窗口的在途工作**原本混在同一个工作树里**（40 个未提交文件）。
任何一方跑的验证都包含别人的改动，不能单独归功。我逐批拆出，在基于
`origin/main` 的隔离 worktree 里分别应用、分别验证、分别提交。

拆开后暴露了 4 处混合工作树掩盖的问题（每处单独 checkout 都会失败）：
- `models/mod.rs` 漏 re-export（E0432）
- `PtyConfig` 新字段未同步到两处测试 fixture（E0063）
- helpers 与阶段A拆分的模块重复定义（TS2300）
- 归属记混：有人以为 `resource_policy` 的 re-export 是自己的

**所以请重点怀疑：还有没有第 5 处、第 6 处没被发现的拆分残留。**

## 四批内容

1. `d57793b` MCP 打开浏览器/文件落在**调用方所在布局**（不再飞到别的布局）
   新增 `orchestratorOpenRouting.ts`、`editorTabActions.ts`、`usePanesStore.crossLayout.test.ts`
2. `3dede5e` 系统资源弹层展示每个会话的**进程明细**
   新增 `SessionProcessInfo` / `TruncatedProcessSummary`
3. `d36cbe9` **会话资源策略批次1**：Windows 降 `PRIORITY_CLASS` / Unix `nice`
   新增 `models/resource_policy.rs`，随会话启动一次性下发
4. `20d0603` 终端**显示错乱/刷新失效**修复 + **后台标签暂停输出**
   新增 `terminalHiddenWriteBuffer.ts`、`terminalOutputHandler.ts`、`terminalViewHelpers.ts`

## 请重点攻击

1. **拆分残留**。四批被我手工拆开重组，重点查：
   - 有没有函数/类型被搬走后原处仍有引用，或两处都定义
   - 有没有某批的改动依赖另一批的文件，但提交顺序反了（单独 checkout 编译不过）
   - `TerminalView.tsx` 被两批同时改过，`usePanesStore.ts` 也是——这两个文件最危险

2. **资源策略（批次1）的正确性**。`pty/job.rs` 现在是**两段式下发**：
   `KILL_ON_JOB_CLOSE`（进程回收）+ 资源策略（优先级）。
   - 第二段失败时，第一段的回收兜底是否**确实**不受影响？（这是硬要求）
   - Windows `PRIORITY_CLASS` 与 Unix `nice` 的失败路径是否都被吞掉了？
   - **macOS 未验证**：`libc::PRIO_PROCESS` 在 Linux 是 `c_uint`、macOS 是 `c_int`，
     靠 libc crate 自身对齐。请静态核对这个假设是否成立。

3. **后台标签暂停输出**（`terminalHiddenWriteBuffer`）。
   - 暂存缓冲有没有上界？长时间后台 + 高频输出会不会吃内存？
   - 切回时一次性回放，会不会造成主线程卡顿（正是它想解决的问题）？
   - 会话在后台**退出**时，缓冲区里的最后输出会不会丢？

4. **alt-screen 剥离改动**（docs/73）。这是历史上出过事的区域，
   CLAUDE.md 有多条相关 gotcha。请核对新逻辑是否与既有约定冲突。

5. **跨布局落位**（第1批）。`usePanesStore` 的跨布局操作容易踩
   CLAUDE.md 那条「Zustand selector 里不要调用返回新集合的 store 方法」。
   新增的 `crossLayout` 路径有没有这个问题？

6. **lineRatchet 基线** `usePanesStore.ts` 3054 → 2879：
   这个值是实测的，但请核对是否与当前文件真实行数一致，
   以及有没有别的文件也该同步收紧却漏了。

7. 有没有**更该改而没改**的地方，或本批引入的新风险。

## 已知且不必再报

- `cargo clippy --all-targets` 在 `origin/main` 基线上就有 **21 个既有 lint**
  （cc-memory 模块同名、cc-cli-adapters needless_return、settings.rs 的 Default 字段赋值等）。
  CI 用的是不带 `--all-targets` 的 clippy，当前 EXIT=0。不要报这些。
- macOS 无实机验证（已在上面第 2 点单列）。

## 输出格式

按严重度排序，每条给 `文件:行` + 问题 + **具体失败场景**（什么输入/状态 → 什么错误结果）。
拿不准的标「存疑」并给验证方法。没问题的部分直接跳过，不用夸。

**发版前审核，请把"会不会让用户的会话/数据出问题"作为最高优先级判据。**
方向错了就直说。
