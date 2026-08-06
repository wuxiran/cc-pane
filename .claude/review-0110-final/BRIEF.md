# 0.11.10 发版前最终评审 BRIEF

## 你的任务

对 `merge/0.11.10` 分支相对 main（`c317385`）的**全量变更**做只读评审，目标是**发版前拦截阻断性缺陷**。
仓库：`D:\04_workspace_rust\cc-book`（WSL 下为 `/mnt/d/04_workspace_rust/cc-book`）。
分支：`merge/0.11.10`。基线：`c317385`。
全量 diff（已排除二进制素材与 lock）：`.claude/review-0110-final/final.diff`（2.4 MB，221 文件，+44103/-1027）。

**只读**。不要修改任何文件、不要 commit、不要跑构建/测试（门禁我已经跑过，见下）。
直接读源码交叉验证 diff，不要只看 diff 就下结论。

## 这批变更是什么

收编 4 个外部贡献 PR：

| 来源 | 内容 |
|---|---|
| PR #49 | 终端粘贴不再强制重建 IME 上下文；原生控件跟随主题 `color-scheme` |
| PR #50 | README 新增 web-access/background-settings 功能卡片；ccchan/Web 访问设置本地化；布局右键菜单 z-index |
| PR #53（含 #51/#52） | **大头**：Provider 双模式（managed/native）架构重写、模型选择、原子写、WSL managed 配置、上下文用量指示器、OpenCode 启动挂死修复 |

我在合并分支上已经做过的修正（**不要重复报这些，除非你认为我改错了**）：
- 回退 PR #50 把 9 个已压缩 GIF 换回未压缩版（+14.4MB）
- 回退 PR #50 把 `_global` 语义从「未匹配会话」改成「已删除工作空间」（后端 `usage_stats_service.rs` 里 `_global` 是 launch_history 查不到/无 workspace_name 的兜底桶，不是已删空间）
- `WebAccessSection.tsx` 未知 `bindMode` 兜底回 `auto`（否则 i18n key 原样渲染给用户）
- ccchan 5 处 effect 从 deps 里去掉 `t`（切语言重跑 bootstrap → cleanup 置 cancelled → `setStarting(false)` 被跳过 → 控件永久禁用 + CLI 孤儿）
- `web/test/setup.ts` 的 localStorage shim 从 `Storage.prototype` 挪到实例（否则 sessionStorage 共用同一个 Map）
- 删 `docs/provider-dual-mode-repair-ai-prompt.md`（过程产物）
- fmt/clippy 修正、`TerminalView.test.tsx` 的 barrier mock 补新导出、lineRatchet 基线上调 6 个文件
- 移除 101 个 0 字节垃圾文件（我自己误提交的 shell 重定向残留）

## 已跑过的门禁（全绿，无管道，退出码逐条确认）

`npx tsc --noEmit` 0 / `npm run test:run` 0（361 文件 3370 用例）/ `npm run build` 0 /
`cargo fmt --all -- --check` 0 / `cargo clippy --workspace -- -D warnings` 0 / `cargo test --workspace` 0

**所以不要报「缺测试覆盖」这类风格问题**，只报会让用户实际踩坑的缺陷。

## 重点审查方向（按风险排序）

1. **managed 模式绝不能静默回落 native**。错的 Provider 与对的 Provider 在 UI 上完全同形，用户无法自察（本仓库有「agent 串台」的同类事故史）。
   查 `cc-panes-core/src/services/provider_resolver.rs`、`cc-cli-adapters/src/opencode.rs`。
   我已核实：resolver 的 managed 失败路径全部 `Err`；opencode 适配器在 `ctx.provider.is_some()` 时对写失败/超时都硬报错。
   **请独立复核有没有第三条路径绕过**（比如 launch_profile、orchestrator、WSL 分支里另起的解析）。

2. **是否吃掉/覆盖用户自己的配置**。`~/.config/opencode/config.json`、`~/.opencode/plugins/*`、`~/.codex/*`、`~/.claude.json`。
   我已核实 managed 写入都落在 `<data_dir>/cli-adapters/opencode/<session_id>/`，用户 config 只读，plugin/theme 走 `write_atomic_if_absent`。
   **请复核 WSL 路径分支与 codex 适配器有没有例外**。

3. **API key / secret 是否会落到日志、错误信息、或 world-readable 文件**。
   `cc-cli-adapters/src/atomic_file.rs` 声称 unix 下 0600，Windows 下无对应处理——Windows 上这些文件的 ACL 是什么？是否可接受？

4. **5s config-write deadline 在慢盘 / WSL / 网络盘上的误判**。超时后 managed 硬失败 = 用户启动直接失败。这个 deadline 合理吗？有没有可观测的错误提示？

5. **上下文用量轮询是否会变成常驻负担**。`web/hooks/useContextUsagePoller.ts` 10s 一次。
   本仓库有事故史：曾给 129 个注册项目各起一个 2s 轮询线程，28.6 核持续忙碌。
   确认：只跟活跃会话、`document.hidden` 停、卸载清理、不会每个 tab 各起一个。

6. **WSL managed 路径转换**。`terminal_service/wsl_codex.rs`。本仓库坑：WSL 里解析到 Windows 版 CLI 时，报错会伪装成我们的路径转换 bug。转换本身是否正确处理盘符、verbatim prefix、UNC？

7. **resume id 链路有没有被这批改动打断**。`launch_history` 的 `resume_session_id` 是历史高发区（docs/45、docs/69）。
   我已核实 `rest_launch_history.rs` 只是加了个原本硬编码 `None` 的 `launch_profile_id` 字段。请复核 daemon 桥与 OSC 捕获链。

8. **PR #49 删掉的两行**：`TerminalView.tsx` 原 1053/1056 的 `clearNativeEditState("before-paste"/"after-paste")`。
   作者在 Linux 实测过，用户已决定原样收。**只需确认删除不会在 Windows/macOS 上产生影响**（这两行在非 Linux-WebKitGTK 环境下走 noop controller）。

9. **任何会在升级后破坏运行中会话的改动**。0.11.8 修过「装更新包不杀在途会话」，不能被这批改动破坏。

10. 你自己发现的其他阻断级问题。

## 输出要求

写到 `.claude/review-0110-final/CODEX-FINAL.md`，用中文，结构：

```
## 结论
BLOCK / 可发版（带条件）/ 可发版

## 阻断项（P0）
- 每条：文件:行 + 具体触发场景 + 用户看到什么

## 建议项（P1/P2）
- 同上格式，标明是否必须发版前修

## 未核查项
- 明确列出你没看的部分，不要用「未发现问题」冒充「已核查」
```

**不确定就标不确定**。宁可少报也不要编。找不到证据的猜测不要写成结论。
