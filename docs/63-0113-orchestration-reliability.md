# 63. 0.11.3 编排可靠性修复清单

> 2026-07-25 建立。承接 0.11.3 规划里的「编排可靠性小包（A3+A4+A5）」，把该条展开成可执行清单。
>
> 原条目范围：cursor/truncated 输出、显式 decision gate、三次失败熔断 / 人工复位；
> 不做 deps DAG、群聊、自动 coordinator。
> （出处 `docs/55-competitor-gap-rescan.md` §5 —— 该文件被 `.gitignore` 的 `docs/55-*.md` 规则排除，
> **仅存在于本机**，故此处内联其结论，不依赖该引用。）
>
> 收录标准：**会让编排静默失败、且外部观测无法区分正常与故障**的问题。
> 这类 bug 的共同特征是"看起来一切正常"——它们比崩溃危险，因为崩溃至少会被发现。

## 0. 一句话总览

| # | 问题 | 来源 | 状态 | 影响 |
|---|---|---|---|---|
| R1 | WSL Codex 派工后 prompt 未提交，进程活着但零输出 | docs/61 | 已实测复现 | 无人值守派工静默永久卡死 |
| R2 | agent 不知道自己在哪个实例，dev/release 静默串台 | docs/62 | 已实测复现 | 整场驱动错误实例，worker 上报被丢弃 |
| R3 | 同一 sessionId 被多个 TerminalView 重复绑定 | docs/61 §3.2 | 已观察，根因未定 | 每分钟刷 DB 报错；疑与 R1 相关 |
| R4 | `session_restore_repo` 用 INSERT 而非 upsert | docs/61 §3.2 | 已定位代码 | 重复绑定时每分钟一条 ERROR 噪声 |
| R5 | dev daemon 随 `tauri:dev` 宿主退出被连坐杀掉 | 另一编排线的观察 | **本文未独立验证** | dev 侧所有托管会话一起消失 |

R1、R2 是本批次的核心（用户明确要求纳入）。

## 1. R1 — WSL Codex 派工静默卡死

**详见 `docs/61-wsl-codex-prompt-unsubmitted.md`。**

- 现象：进程活着、cwd/YOLO 正确、prompt 完整传入，但 PTY 零输出、CPU 零占用、`lastOutputAt` 永不前进；
- 判活不能只看 `get_session_status`；临时解法是 `write_to_session(sessionId, "\r")`；
- 代码锚点 `cc-panes-core/src/services/terminal_service/wsl_codex.rs:445-458`（prompt 作为位置参数）；
- **对照实验尚未做**（docs/61 §5）：短 prompt 对照、`beside` vs `tab` 落位对照。
  **修之前必须先做这两个实验**，否则不知道在修什么——现在只知道"发个 CR 能救活"。

修复方向（择一，取决于对照实验结论）：

- 若是超长位置参数导致：改为非位置参数传递（参考同文件 `:1017-1026` 的 opencode 已因同类问题改用 `--prompt`）；
- 若是缺一次提交事件：在 PTY 附着后补发，但**必须能区分"已提交"与"未提交"**，否则会给正常会话注入多余回车。

**兜底（无论根因如何都该做）**：`launch_task` 返回前或返回后短时内验证会话真的产出了输出，
没有则显式报告"启动可能未生效"，而不是返回一个看起来成功的 sessionId。

## 2. R2 — 实例身份缺失导致静默串台

**详见 `docs/62-agent-instance-identity.md`。**

四层修复，建议全做（排序：④根因 / ②防线 / ①能力 / ③最便宜）：

| 层 | 内容 | 代码锚点 |
|---|---|---|
| ① | orchestrator 不健康时也必须注入 `CC_PANES_INSTANCE` / `CC_PANES_APP_DIR` / `CC_PANES_ORCHESTRATOR=unavailable`——**留白是最坏选项** | `terminal_service.rs:1606-1620` |
| ② | `launchId` 自洽校验：客户端约定 + **服务端硬拒绝**不属于自己的 launchId | 参考 `cc-panes-ctl/src/discovery.rs::validate_identity` 的分级判定 |
| ③ | MCP initialize 的 instructions 里带 `instance/dir/port` | 服务端 instructions 已存在，加一行即可 |
| ④ | `~/.claude.json` 的 project 级单例改为 per-session（机制已存在：`mcp-<sessionId>.json`） | **待核实**：哪些启动路径写 project 级、CLI 配置优先级 |

②是本清单里**唯一能让故障立刻暴露**的一条，优先级不应低于④。

## 3. R3 / R4 — 会话重复绑定与非幂等写入

- R3：同一 sessionId 出现在两个 TerminalView 实例 / 两个 tab（实测：`list_panes` 里 #3 与 #4 标题相同、`sessionId` 相同）。
  背景有"React 19 严格模式 dev 下 useEffect 双挂载"（见 CLAUDE.md），但**是否同因未验证**；
- R4：`cc-panes-core/src/repository/session_restore_repo.rs:24` 是 `INSERT INTO terminal_sessions`（非 upsert），
  :55 报错。R3 触发时每分钟刷一条 `UNIQUE constraint failed`。

R4 是确定的小修（改 upsert / `ON CONFLICT`），但**不要用它掩盖 R3**——把报错消掉不等于重复绑定消失。
建议：R4 修成幂等的同时，对重复绑定加一条可观测的 WARN，保留发现 R3 的能力。

## 4. R5 — dev daemon 连坐（未独立验证）

另一条编排线报告：dev daemon 在宿主 `tauri:dev` 退出时被连坐杀掉，导致其托管的全部 dev 会话消失；
release daemon 不受影响（同期 PID 存活多日）。

daemon 的设计目标本就是"活过应用重启"（见 CLAUDE.md：daemon 是跨 app 重启存活的锚点），
若 dev 下不成立，则 dev 环境里的编排可靠性结论**不能外推到 release**，反之亦然。

> **本文未独立验证 R5**，仅记录来源与影响面，待验证后再决定是否纳入本批次。

## 5. 批次建议

优先级：**R2② > R1（含对照实验）> R2①③④ > R4 > R3 > R5**。

理由：R2② 是唯一的"让错误立刻可见"机制，成本低、收益最高；R1 必须先做对照实验才谈得上修；
R3 根因不明，贸然改双挂载逻辑风险高于收益。

**共同的验收标准**：修完之后，构造故障场景时系统必须**明确报错或告警**，
而不是继续返回看起来正常的结果。本清单里每一条的危害都不在于失败本身，而在于失败无声。
