# 交叉评审：PR #53（Provider 双模式 + 上下文用量指示器 + OpenCode 启动挂死修复）

## 你的角色

只读交叉评审。**不要修改任何文件、不要跑构建/测试**。你的产出是一份结论清单，我会逐条独立核实后自己动手改。

## 背景

仓库：CC-Panes（Tauri 2 + React 19 + Rust workspace）。
被评审内容：外部贡献者 zhengjunkj 的 PR #53，已合进本地分支 `merge/0.11.10`，准备随 0.11.10 发版。
规模：135 文件，+11792/-836。

全量 diff：`.claude/review-0111-pr53/pr53.diff`（相对 main 的 `c317385`）。
仓库根 `CLAUDE.md` 有一大段 "Known Gotchas"，是本仓库踩过的坑，**评审时请逐条对照**。

## 重点核查项（按风险排序）

1. **`cc-panes-core/src/services/provider_resolver.rs`（新增 1219 行）**
   - managed / native 分流是否存在"静默走错 Provider"的路径？对照 CLAUDE.md 里
     「agent 串台」那条：错的 Provider 与对的 Provider **完全同形**，用户无法自察。
   - managed 模式下**绝不能** fallback 到 native。作者称已有测试覆盖——请核实那些断言
     是真的在验证行为，还是只是形式上通过。

2. **配置写入的原子性与用户数据安全**
   - `write_managed_provider_config` / `cc-cli-adapters/src/atomic_file.rs` 是否真原子？
     注意 Windows 上 `rename` 覆盖已存在文件的语义。
   - 是否会吃掉/覆盖用户自己的 `~/.config/opencode/config.json` 与
     `~/.opencode/plugins/ccpanes.js`？备份与恢复路径是否完备？

3. **`cc-cli-adapters/src/atomic_file.rs` vs 已存在的 `cc-panes-core/src/utils/atomic_file.rs`**
   - main 上后者**已经存在**。判断这是有意分层（crate 依赖方向所迫）还是重复造轮子。

4. **WSL managed 路径（`terminal_service/wsl_codex.rs` +414）**
   - 对照 CLAUDE.md 两条：「WSL 里的 CLI 必须是原生 Linux 版」「WSL 路径转换报错会伪装成
     我们的 bug」。managed 配置写到 WSL 侧时路径转换是否正确？

5. **上下文用量轮询（`web/hooks/useContextUsagePoller.ts`、`useActiveTerminalSession.ts`）**
   - 默认 5s × 每活跃会话。对照 CLAUDE.md「不要给全部注册项目起常驻监视/轮询」那条事故
     （129 个项目各起 2s 轮询 → 28.6 核持续忙碌）。
   - 必须**跟随活跃会话惰性起停**：标签关闭/后台/会话退出后轮询是否真的停？有没有泄漏的
     interval？
   - 数据来源是否在 daemon 模式下有效？对照 CLAUDE.md「PTY 迁到 daemon 后，任何从 app 进程内
     TerminalService 取数据的链路都会静默失效」那条。

6. **`web/services/terminalLaunchDeadline.ts` + 5s config-write deadline**
   - 慢盘 / WSL / 首次冷启动下会不会误判超时？
   - `launch-timeout` 会不会被当成真实退出码？对照 CLAUDE.md「`-1` 是合成码」那条。

7. **`orchestrator_service.rs`（+523）与 `terminal_service.rs`（+491）**
   - 是否破坏了会话恢复、resume id 落库（docs/69）、daemon 桥接口径？

8. **`vite.config.ts` 的 `**/*-target/**`**
   - 方向与 CLAUDE.md 里 `server.watch.ignored` 那条事故一致，确认没有**漏掉**现有 ignore 项
     （漏掉会重现 Vite 烧 2.9GB 内存那次事故）。

9. **`docs/provider-dual-mode-repair-ai-prompt.md`**
   - 这是喂给 AI 的过程产物，我倾向合并前删掉。确认它没有被其他文档引用。

10. **`usage_stats_service.rs`（+640）**
    - 注意 `_global` 是「launch_history 查不到或没有 workspace_name」的兜底桶，
      **不是**「已删除的工作空间」。本批次另一个 PR 曾把这个语义搞反，已回退。
      确认 #53 没有再次踩到。

## 输出格式

每条一个条目：

```
[严重度 blocker/major/minor] 文件:行
现象：
为什么是问题（说清失败场景：什么输入/状态 → 什么错误结果）：
建议改法：
```

没问题的重点项也请明确写「已核查，无问题」并给出你核查的依据，便于我判断你是否真的看了。
不确定的标 `[uncertain]`，不要为了凑数编造。
