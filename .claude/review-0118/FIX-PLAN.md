# 修复交接件 · 依据你自己的评审结论

你上一轮的只读评审已被采纳。三条关键论断我独立核实过，**全部成立**：

- `TerminalTabContent.tsx:170` 确实是 `projectId={tab.projectId}`（leaf 共用 tab 级 id）
- `resume_identity.rs:13` 确实是 `"issued" | "osc-title" => 30`（同级）
- `restoreReport.ts` 确实没有排除 `cliTool === "none"`

现在请你**实施修复**。以下是范围与边界，超出的部分不要动。

## 采纳你的方案边界

> 每个 TerminalPaneLeaf 持有独立 launch id，每次真正创建 PTY（含恢复和分屏）都生成
> 新 id 并创建新历史行；稳定的 tab id、conversation resume id、一次性 launch id 必须分离。
> 写入应在单一事务中完成 PTY 绑定、来源仲裁和 resume source 更新。

## 本轮要修（P1，按依赖顺序）

**第 1 步是地基，先做完再往下。**

1. **leaf 级 launch identity**（你的发现 #1、#3 的根）
   - `TerminalPaneLeaf` 增加自己的 launch id 字段；`usePanesStore.ts:158` 克隆 leaf 时生成新 id
   - `TerminalTabContent.tsx:170` 传 leaf 的 id 而非 `tab.projectId`
   - 恢复路径（`TerminalView.tsx` 的 `init.create` / `activation.create`）每次真正建 PTY 时生成新 launch id，**不要复用上次的**
   - 注意持久化兼容：老快照里的 leaf 没有这个字段，要能迁移（缺失时按需补生成），不能让老用户的布局炸掉

2. **写入原子化 + 来源仲裁**（你的发现 #2、#3）
   - `history_repo.rs` 的 `upsert_session_started`：UPDATE + INSERT 放进单一事务
   - 兜底路径必须走 `should_replace_source` / CLI 冲突判定，不能让 `rollout-scan`(10) 覆盖 `issued`(30)
   - `resume_binding_service.rs` 的 `upsert_missing_row` 按上面两点重写
   - 加 `UNIQUE(project_id)`（需迁移：先清理历史重复行）。**注意这是必要不充分**，你自己说过单加唯一索引解决不了第 1 条

3. **A3 报告口径**（你的发现 #8）
   - 排除 `cliTool === "none"`（纯 shell 无 resume 语义，全 shell 时当前必然误报）
   - 按 leaf 统计而非 tab（分屏时只看 active leaf 会漏报）
   - 区分 `adopted`(daemon 热接管) / `resumed` / `fresh` / `shell`，只有真正该有 resume id 却没有的才算回归
   - 相应更新 `RestoreRegressionBanner.test.tsx`，**必须新增一条"全是纯 shell 时不报警"的用例**

4. **daemon 换代**（你的发现 #5、#6）
   - 判定要同时看 `session_count` 和 `desktop_client_count`（别的实例在用就不能退）
   - 会话降到零后要能重新评估，不能只在启动/重连时判一次
   - 我代码注释里写的「端口冲突时新 daemon 自己会失败」是**错的**（新 daemon 用随机端口），请一并订正注释
   - 原子的 retire-if-idle-and-unshared 若要改 daemon 端点，可以做，但要保持旧 daemon 兼容（字段缺失按降级处理，见 CLAUDE.md）

## 本轮不要动（标注即可，别改）

- **#7 mtime 判据**、**#9 卸载漏杀已改名 daemon** —— 两条都只能在 Windows 宿主实测，
  你在 WSL 里改了也验不了。请在代码注释里写明「待 Windows 实测」和你建议的验证步骤，
  不要凭猜改判据。
- **#4 backfill 默认关闭** —— 结论已确认（`resume_id_backfill_enabled` 默认 false）。
  `TerminalView.tsx` 那两处放开门槛的改动保留即可，它在默认配置下不生效，无害。
  不要为它新增后端行为。

## 纪律

- 改动过程中**不要跑测试**，最后一次性跑，范围最小：
  ```
  npx tsc --noEmit && echo "EXIT=$?"
  cargo clippy --workspace -- -D warnings     # 不加 | tail，会掩码退出码
  cargo test --manifest-path src-tauri/Cargo.toml
  cargo test -p cc-panes-core
  npx vitest run --maxWorkers=3               # 高负载假失败先重跑再判
  ```
- 已知基线噪音（非你引入）：`clippy --all-targets` 会在 `cc-memory/src/tests.rs`、
  `cc-cli-adapters/src/codex.rs:537` 报 2 个历史 lint。不带 `--all-targets` 时干净。
- 遵守 `CLAUDE.md` 的编码规范与 Known Gotchas。
- **不要碰** `.claude/review-0118/` 下的文件，也不要提交 git。
- schema 迁移必须可重入（`CREATE TABLE IF NOT EXISTS` 之外还要考虑已有库的 ALTER 路径）。

## 完成后

写一份 `.claude/review-0118/FIX-REPORT.md`：每条改了什么、为什么、涉及文件行号；
未修的 #7/#9 写清楚待验点；测试结果如实贴（失败就贴失败，别修饰）。
