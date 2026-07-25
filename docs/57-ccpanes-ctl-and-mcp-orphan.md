# 57. cc-panes-ctl 立项 + MCP 孤儿最后缺口

> 2026-07-25 立项。起因：release 实例 orchestrator 死亡（47821 幽灵 socket）导致全部在途会话 MCP 失联、leader 汇报链路瘫痪的实战事故。继任 leader 靠 daemon REST + 手写 curl + sqlite 直写完成接管——每一步都有 API 兜着，但没有一个现成命令。本文定义两个工作项的边界与验收。

## 0. 事故还原（为什么是这两个件）

1. release 实例崩溃重启后，固定端口 47821 被前一个死进程的幽灵 socket 占住（netstat 显示 LISTENING 但 owner pid 已不存在、连接被拒），新实例绑定失败后**静默放弃**——release 实例带病运行：UI 正常、orchestrator 不存在、无任何提示。
2. 在途会话（leader + 4 worker）的 MCP 全部孤儿化：CLI 的 MCP client 只在进程启动时读一次配置（docs/18:507），端口/token 再对也连不上一个不存在的服务。
3. worker 双保险纪律第三次救场：交付靠 worktree git log + WORKER-REPORT.md 被继任 leader 发现；绑定落账靠 leader 直写 SQLite 代账。
4. 接管全程可行但全是手工：daemon-manifest 取 token → curl daemon REST 读会话 → sqlite 清绑定。

**结论**：方案 A（固定端口 + token 复用，docs/37，已落地）解决了"正常重启后失联"；剩两个缺口——①绑定失败静默降级 ②没有 CLI 兜底通道。

## 1. 工作项一：orchestrator 绑定失败硬化（小件，可先行）

- **重试**：`bind_fixed_port` 失败后带退避重试（幽灵 socket 通常随 TIME_WAIT 类状态在数十秒内释放），重试期间 orchestrator 状态为 `binding`；
- **可见报警**：重试穷尽后**必须**在 UI 上可见地报警（状态栏/横幅，附逃生阀 `CC_PANES_ORCHESTRATOR_PORT` 指引），禁止静默降级——同 CLAUDE.md"降级必须对用户可见"教训（docs/45 Codex resume 同族）；
- **验收**：人工制造端口占用 → 启动 → 观察重试与报警；释放端口 → 观察自动恢复。

## 2. 工作项二：cc-panes-ctl（CLI 薄壳 + stdio MCP 代理，二合一）

### 2.1 定位

服务端接口早已齐备（orchestrator MCP 88 工具 + REST 18 路由、daemon REST 16 路由），缺的只是消费端薄壳。一个二进制、两个角色：

| 角色 | 子命令形态 | 解决什么 |
|------|-----------|---------|
| **人类/AI 命令面** | `cc-panes-ctl sessions list / read <id> / submit <id> <text> / kill <id>`、`bindings list / reconcile`、`status` | orchestrator 死了也能经 daemon 接管会话（本次事故的手工流程命令化） |
| **stdio MCP 代理** | `cc-panes-ctl mcp-proxy`（作为 CLI 会话注入的 stdio MCP server） | docs/37 方案 C：CLI 配置里彻底不出现端口，每次请求实时解析真实端点 → 根治 MCP 孤儿 |

### 2.2 关键设计约束

- **端点解析复用 hook 模式**：`cc-panes-cli-hook` 从不失联，因为它每次调用都重新解析（探活 → 失败重读 manifest，`resolve_api_endpoint()`）。ctl 的两个角色都必须用同一模式，且为**双源降级**：orchestrator manifest → 探活失败 → daemon manifest（runtime/daemon-manifest.json）。
- **dev/release 双数据目录**：跟随 `ORCHESTRATOR_FIXED_PORT` 的对应关系（dev 47822/`~/.cc-panes-dev`，release 47821/`~/.cc-panes`）；ctl 需 `--dev` 开关或自动探测两套。
- **mcp-proxy 历史包袱**：曾有 `ccpanes-proxy.mjs` 遗留死条目（docs/18:330——.mjs 从未被任何版本生成过，属未走通的实验），`claude.rs` 现在会主动剥离这些条目。新代理落地时：①换名（`cc-panes-ctl mcp-proxy`）避开剥离逻辑 ②确认剥离逻辑不误伤新条目。
- **代理的降级语义**：orchestrator 不可达时，mcp-proxy 对工具调用返回明确错误（含"orchestrator down, N 秒后重试"），**不静默吞**；会话级 MCP 工具（submit/output 类）可考虑 daemon 直连兜底。
- 二进制归属：新 crate `cc-panes-ctl`（workspace member），端点解析逻辑从 cli-hook 抽到共享处（cc-panes-core 或独立小 crate），**不复制粘贴**。

### 2.3 工量与验收

- 工量：命令面 ~0.5d + mcp-proxy ~0.5-1d（解析逻辑是现成的）。
- 验收：
  1. 杀掉 orchestrator（模拟事故）→ `sessions list/read/submit` 经 daemon 照常工作；
  2. 注入 mcp-proxy 的 Claude 会话在 CC-Panes 重启（端口/token 轮换）后 MCP 工具**不断线**；
  3. `bindings reconcile` 能完成本次事故中手写 sqlite 的落账动作；
  4. 常规检查（clippy/fmt/test）+ 双数据目录各验一遍。

## 3. 关系与顺序

- 工作项一独立、先行（改动小，防再犯）；
- 工作项二依赖 docs/37 的 manifest 体系（已在 main），不依赖工作项一；
- 两项完成后，"MCP 端口重启即孤儿"问题族闭环：正常重启 → 方案 A 覆盖；异常绑定失败 → 工作项一可见化；任何情况下的接管/自愈 → ctl 兜底。
- leader 会话不可迁移（本次"重注册真身"的根源）不在本文范围，另行立项。
