# CODEX-FINDINGS

审查状态：PARTIAL。按用户要求，context 压缩后立即收尾；本文件只记录压缩前已经核查出的结论，未继续开启新的代码探查。

验证限制：
- 只读源码/差异审查。
- 未运行构建、测试、格式化或 lint。
- 未核查完成的条目明确标注为「未核查」或「部分核查」，不作为 PASS 结论。

## 总体结论

已核查项未发现确定性阻断缺陷。当前不能给出全量 PASS，因为 atomic file Windows 语义、BRIEF 第 9 项引用闭环、以及部分 workspace/orchestrator 侧链路尚未完成核查。

## 按 BRIEF 重点项逐条结论

1. Provider resolver 的 native/system 路径：PASS。
   - 结论：`selection=None` 和 `SYSTEM_PROVIDER_ID` 均直接回到 native；没有被 managed provider 默认接管。
   - 证据：`cc-panes-core/src/services/provider_resolver.rs:134-315`。

2. Provider inherit / 显式选择 / builtin 兼容性：PASS。
   - 结论：`Inherit` 按 request/profile/workspace/default 解析；显式 provider 需要存在、可用且与 CLI 兼容。压缩前已确认测试覆盖 builtin managed/native 场景。
   - 证据：`cc-panes-core/src/services/provider_resolver.rs:134-315`。

3. atomic file 写入与 Windows 覆盖语义：未核查。
   - 未完成项：尚未完成 `cc-cli-adapters/src/atomic_file.rs` 中 `ReplaceFileW` / `hard_link` 的 Windows 行为核验，也未闭环它与 `cc-panes-core/src/utils/atomic_file.rs` 的重复实现风险。
   - 结论：不能判定 PASS。

4. OpenCode config 写入 5s deadline：PASS。
   - 结论：真正的 5s bounded 写入在 `write_session_configs_bounded`，不是前端 launch grace timeout。
   - 证据：`cc-cli-adapters/src/opencode.rs:28-547`。

5. 前端 terminal launch deadline 是否误当 5s config deadline：PASS。
   - 结论：`web/services/terminalLaunchDeadline.ts` 是 55s UI launch grace；restore queue 另有 60s 超时。它不是 OpenCode session config 写入的 5s deadline。
   - 证据：`web/services/terminalLaunchDeadline.ts:4-58`。

6. WSL managed OpenCode/Kimi/GLM 路径转换：PASS。
   - 结论：managed provider 的 config/data/env 路径会转成 WSL 路径；`windows_path_to_wsl` 已处理盘符和 verbatim prefix。
   - 证据：`cc-panes-core/src/services/terminal_service/wsl_codex.rs:685-764`、`cc-panes-core/src/services/terminal_service/wsl_codex.rs:1120-1196`。

7. Context usage poller 的活跃会话与 SSH gating：PASS。
   - 结论：只在活跃 terminal、CLI 为 `claude`/`codex`、且非 SSH 时轮询；隐藏或卸载后停止轮询。
   - 证据：`web/hooks/useContextUsagePoller.ts:7-44`。

8. Context usage 后端数据链路与 `_global` 桶：PASS。
   - 结论：前端链路为 `usageStatsService.queryContextUsage -> query_context_usage`；后端 `UsageStatsService::context_usage_for_pty` 依赖 launch history 与磁盘 JSONL，不依赖进程内会话表。`_global` 是未匹配会话桶，UI 文案按“未匹配会话”理解。
   - 证据：`cc-panes-core/src/services/usage_stats_service.rs:323-356`、`cc-panes-core/src/services/usage_stats_service.rs:684-940`。

9. `docs/provider-dual-mode-repair-ai-prompt.md` 相关项：部分核查。
   - 已知结论：压缩前的文件枚举未在当前树中找到该路径；只命中 `docs/bugs/opencode-launch-hang-2026-08-03/README.md`。
   - 未完成项：尚未完成“是否仍被引用/是否存在残留入口”的闭环核查。
   - 结论：不能判定 PASS。

10. workspace/orchestrator/provider compatibility 跨层闭环：未核查。
    - 已读范围：压缩前已扫 `src-tauri/src/services/orchestrator_service.rs:4460-4708`、`web/utils/workspaceLaunch.ts`、`web/utils/providerCompatibility.ts`。
    - 未完成项：尚未形成 request -> frontend compatibility -> backend resolver/orchestrator 的完整闭环结论。
    - 结论：不能判定 PASS。

## 发现的问题和建议

未确认 P0/P1 级确定性 bug。

建议后续只补以下未闭环项：
- 核查 `cc-cli-adapters/src/atomic_file.rs` 在 Windows 上的 replace/link 语义及与 core atomic helper 的一致性。
- 核查 BRIEF 第 9 项涉及的旧 prompt/doc 路径是否仍被引用。
- 核查 workspace launch、provider compatibility、orchestrator 到 provider resolver 的完整跨层契约。

