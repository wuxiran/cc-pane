# 62. Agent 不知道自己挂在哪个实例：静默跨实例串台

> 2026-07-25 实测发现。一个 release 侧的 leader 会话整场都在驱动 dev 实例的 orchestrator，
> 直到派出去的 worker 两次上报被丢弃才暴露。
>
> 一句话：**orchestrator 不健康时不注入任何身份信息，CLI 于是静默回退到项目级共享配置——
> 而那份配置可能是另一个实例写的。**

## 1. 事故经过

leader 会话（release 侧，`CC_PANES_PTY_SESSION_ID=0c4d3e1e…`）：

1. 全程用 MCP 工具派工、查状态，**全部命中 dev 实例**；
2. 派出的 worker 落在 dev 的面板里，leader 在 release 界面上看不到它；
3. worker 完工后两次 `report_to_leader`，dev 日志两条：
   `WARN worker report skipped: leader session not found worker_id=88aedbe3 leader_id=d2cd9d9d`
   —— dev 里当然找不到这个 leader，它在 release；
4. leader 因此**永远收不到 PTY 反馈**，靠自己挂的文件系统看门狗才发现 worker 已完工；
5. leader 据 dev 的 `list_panes` 得出"#1 窗口是空的"，而用户看的是 release 的窗口——**结论错误且无法自察**。

## 2. 因果链（已验证）

| 环节 | 证据 |
|---|---|
| API 身份 env 的注入有前置条件 | `cc-panes-core/src/services/terminal_service.rs:1606-1620`：`healthy_orchestrator_info()` 返回 `None` 时，`CC_PANES_API_PORT/TOKEN/BASE_URL` **一个都不注入** |
| 该会话所在实例的 orchestrator 确实不健康 | `cc-panes-ctl --release status` → `orchestrator=failed  daemon=ready`，原因 `读取 ~/.cc-panes/mcp-orchestrator.json 失败 (os error 2)` |
| 该会话没有专属 MCP 配置 | `~/.cc-panes/` 下只有 `mcp-bed93f4d-….json`（另一会话），**没有** `mcp-0c4d3e1e-….json` |
| 回退到的项目级配置属于另一实例 | `~/.claude.json` 的 `projects["D:/04_workspace_rust/cc-book"].mcpServers.ccpanes` = `http://127.0.0.1:<devPort>/...`（**dev 实例的端口与 token**）；而 release 给别的会话写的专属配置指向 `http://127.0.0.1:<releasePort>/...`（**另一套端口与 token**）——两者端口、token 均不同 |
| 身份自相矛盾且无人校验 | 会话真实 `CC_PANES_LAUNCH_ID=proj-8beebc9a…`，而所连 MCP URL 里的 `launchId=proj-15cbc54f…`。**两者不等，服务端照常提供服务** |

## 3. 为什么很难自察

会话拿到的 `CC_PANES_*` 只有：`CLI_TOOL / LAUNCH_ID / PROJECT_PATH / PTY_SESSION_ID /
RUNTIME_KIND / WORKSPACE_NAME / WORKSPACE_PATH / WORKSPACE_SNAPSHOT_ID`。

**没有任何一个字段说明"我属于 dev 还是 release"**，也没有 API 端点可供交叉验证（恰恰因为
orchestrator 不健康才没注入）。MCP 工具全部正常返回数据——只是那是另一个实例的数据。
从 agent 的视角，一切都"工作正常"。

## 4. 修复方案（四层，建议全做）

> 排序：④ 是根因，② 是防线，① 是能力，③ 最便宜。
> 修了 ④ 仍然需要 ②——配置还会因换端口、token 轮换等其他原因变陈旧。

### ① 无条件注入实例身份

把身份与端点解耦：即使 `healthy_orchestrator_info()` 为 `None`，也必须注入

```
CC_PANES_INSTANCE=dev|release      # 由 APP_DIR_NAME 推导，永远可知
CC_PANES_APP_DIR=<数据目录>
CC_PANES_ORCHESTRATOR=unavailable  # 明确告知"端点缺失"，而不是留白
```

留白是最坏的选项：它让下游无法区分"没有端点"和"端点在别处"。

### ② launchId 自洽校验（唯一能让故障立刻暴露的一条）

- **客户端约定**：MCP URL 里的 `launchId` 必须等于 `$CC_PANES_LAUNCH_ID`，不等即为串台；
- **服务端强制**（更强）：orchestrator 收到不属于自己的 `launchId` 直接拒绝，而不是照常服务。

本次事故中这条若存在，第一次工具调用就会报错，而不是让错误持续整场。
参考既有分级判定思路（`cc-panes-ctl/src/discovery.rs::validate_identity`）：
**字段缺失 → 降级可用并告警；字段存在但对不上 → 硬失败**。本例正属于"存在但对不上"。

### ③ MCP instructions 里带实例身份（零成本）

服务端 initialize 已返回 instructions（`CC-Panes Orchestrator: 多 CLI…`）。
加一行 `instance=release / dir=~/.cc-panes / port=47821` 即可——所有 agent 握手时必然看到，
不需要任何客户端配合，也不需要改 env 注入链路。

### ④ 根因：per-project 单例配置改为 per-session

`~/.claude.json` 的 `projects.<path>.mcpServers.ccpanes` 是**按项目路径的单例**：
dev 与 release 打开同一个项目时互相覆盖，后写的赢。

per-session 机制已经存在（`mcp-<sessionId>.json`），需要把它覆盖到**所有**启动路径，
并让 CLI 优先使用它。

> **待核实**：具体哪些启动路径会写 project 级配置、CLI 的配置优先级顺序如何，
> 本文未通读 `mcp_config_service.rs` 与 Claude Code 自身的配置解析，不作结论。

## 5. 与 docs/61 的关系

两者叠加会形成极难排查的组合：docs/61 让 worker "活着但一动不动"，本文让 leader
"连到了错的实例"。**两种故障的外部表现都是"派出去的活没有反应"**，但根因一个在 PTY 提交、
一个在配置串台，排查方向完全相反。

遇到"worker 没反应"时，建议的分辨顺序：

1. 先验身份：`env | grep CC_PANES_LAUNCH_ID` 与所连 MCP URL 里的 `launchId` 是否一致（本文）；
2. 再验进程：`wsl.exe -d Ubuntu -- bash -lc "ps aux | grep codex"` 是否活着但零 CPU（docs/61）。

## 6. 临时绕法（修复前）

- 会话开始时先自查一次 launchId 是否自洽；
- release 侧 orchestrator 挂了但 daemon 活着时，走 `cc-panes-ctl --release sessions list/read/submit`
  （能力分层见 CLAUDE.md：MCP 全量工具与 `launch` 依赖 orchestrator，会话原语可经 daemon 降级）。
