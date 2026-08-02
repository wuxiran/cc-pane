# 0.11.8 发版审核修复报告

## 已修复

### #1 后台输出缓冲的端到端内存上界

- `web/components/panes/terminalHiddenWriteBuffer.ts:8-10,68-77`
- `web/components/panes/terminalOutputHandler.ts:80-83,136-143`

旧实现达到 512 KiB 后把整块 fire-and-forget 给 xterm，只清空本地数组；未完成的
Promise 和 xterm 写队列仍持有每个块，所以持续输出时总内存没有上界。

新实现隐藏期间最多保留 512 KiB 的完整 chunk 前缀。首次越界后冻结该缓冲，后续隐藏
输出不再提交给 xterm；恢复或退出时写入已保留前缀和明确的截断提示。这样待写数据不会
转移到异步队列，代价是超过硬上限的后台输出被显式截断，而会话进程本身不受影响。

回归测试：`web/components/panes/terminalHiddenWriteBuffer.test.ts:33-64` 覆盖连续越界、
单个超大 chunk、固定内存上界和截断提示。

### #2 后台会话退出时尾部输出丢失或乱序

- `web/components/panes/terminalOutputHandler.ts:32-73`
- `web/components/panes/TerminalView.tsx:684-703`

退出处理现在先 drain 隐藏缓冲，并等待 xterm 写回调完成后再写退出/SSH 断连提示，最后
才通知父组件会话退出。写失败仍记录诊断并继续退出通知，避免会话关闭流程被阻断。

组合时序测试：`web/components/panes/TerminalView.test.tsx:719-744` 同时触发“隐藏输出 +
退出”，断言尾部输出先于 `Process exited` 出现。

### #5 Unix nice 增量被当成绝对值

- `cc-panes-core/src/pty/mod.rs:261-301`
- `cc-panes-core/Cargo.toml:56-58`
- `Cargo.lock`（为 cc-panes-core 记录既有 `errno` 包的直接依赖关系）

保留 `nice_increment` 的增量语义。下发时先用 `getpriority` 读取子进程继承到的当前 nice，
清 errno 以区分合法的 `-1` 与系统调用失败，再计算 `min(current + increment, 19)` 后调用
`setpriority`。查询或设置失败仍只 warn，不阻断会话启动。

回归测试：`cc-panes-core/src/pty/mod.rs:427-434` 覆盖 nice 0、nice 10、上限夹取和负 nice。

### #9 helpers 拆分残留

- `web/components/panes/terminalViewHelpers.ts`
- `web/components/panes/terminalLaunchIdentity.ts:47-58`
- `web/components/panes/terminalSessionNotices.ts:10-18`

删除 helpers 中重复的 `resolveCliTool`、`resolveRuntimeKind`、`notifySessionClaimed`，连同
第二份 cooldown Map 和无用 import。全仓搜索确认调用方只使用两个专门模块。

### #7 嵌套会话进程归属

- `cc-panes-core/src/services/system_stats_service.rs:469-504`
- `cc-panes-core/src/services/system_stats_service/tests.rs:215-276`

静态确认原实现确实依赖输入顺序：父根先出现时会先认领嵌套根的全部后代。现在按根进程
在进程树中的深度降序认领，更具体的嵌套根优先；同深度按 `session_id` 固定顺序，最终
展示顺序仍按 `session_id`。回归用例以 `[父, 子]`、`[子, 父]` 两种输入验证结果一致。
该用例已在 `cargo test -p cc-panes-core` 中实际通过，存疑项结论为“成立，已修复”。

## 判断后不修

### #3 Files 视图绕过调用方布局

`origin/main` 的 `usePanesStore.openEditor` 已在 Files 视图提前转到全局
`useEditorTabsStore`；本批只是把原逻辑搬到 `web/stores/editorTabActions.ts:68-75`，没有
使该路径变坏。按 FIX-PLAN 条件，本轮不修，登记为独立的跨布局契约补全项。

### #4 alt-screen 根因未修

`web/components/panes/terminalBufferMode.ts:138-142` 的 Claude/Codex/OpenCode 剥离名单与
`origin/main` 完全一致。本批只在用户主动选择“刷新终端显示”时增加 SIGWINCH，默认输出
路径没有新增退化，因此不回退；发布说明应写“缓解而非根治”，剩余方案继续留在 docs/73。

## 明确排除

- #6 `PolicyOutcome` 回传前端：按计划留给资源策略后续批次。
- #8 其他三处 lineRatchet 松动基线：非本批造成，本轮未修改。
- 未提交 Git，未修改版本号。

## 验证

按 FIX-PLAN 要求，开发过程中未运行测试，全部检查集中在最终验证阶段执行：

```text
PASS  cargo fmt --all -- --check
PASS  npx tsc --noEmit
PASS  cargo clippy --workspace -- -D warnings
PASS  cargo test -p cc-panes-core
      890 unit passed / 1 ignored；集成测试 6 + 8 + 3 passed
PASS  cargo test --manifest-path src-tauri/Cargo.toml
      275 unit passed；集成测试 15 + 3 + 1 + 13 + 5 passed
PASS  npx vitest run --maxWorkers=3 web/components/panes web/stores
      92 files passed；1146 tests passed
```
