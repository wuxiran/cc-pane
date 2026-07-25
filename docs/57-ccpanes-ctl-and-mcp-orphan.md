# 57. cc-panes-ctl 立项 + MCP 孤儿最后缺口

> 2026-07-25 立项，同日经 WSL Codex 独立同行评审（19 必修 / 4 开放）后**整体重写**。起因：release 实例 orchestrator 死亡（47821 幽灵 socket）导致全部在途会话 MCP 失联、leader 汇报链路瘫痪的实战事故。继任 leader 靠 daemon REST + 手写 curl + sqlite 直写完成接管——每一步都有 API 兜着，但没有一个现成命令。

## 0. 已评审决议（拒绝/收窄项，勿重提）

| 原提法 | 决议 |
|---|---|
| `bindings` 走 orchestrator REST 优先 | **删除**——REST 无 binding 端点，只有 `/mcp` 的 `query_task_bindings`/`update_task_binding`/`reconcile_plan_collaboration`。改为经 MCP 客户端 |
| mcp-proxy「每请求重解析端点 → 永不断线」 | **收窄**——每请求换 URL 不能续接 MCP 会话；需完整会话状态机，且失败重试只限"明确未执行"场景（见 §3.2） |
| 「88 个 MCP 工具」 | **改为 86**（源码实际 `#[tool]` 数），且验收以运行时 `tools/list` 快照为准，不写死数字 |
| `resolve_api_endpoint()` 扩展为返回 daemon | **拒绝**——hook 依赖多个 orchestrator-only 路由，返回 daemon 会让 hook 静默走错。改为两个独立函数 |
| bindings 降级"直写 SQLite"作为常规路径 | **降级为紧急逃生阀**（`--force-offline-db` + 强校验），默认禁止（见 §4） |
| 幽灵 socket 靠"退避重试"解决 | **根因已由 `059f386` 消除**（见 §1），重试降为纵深防御，报警才是主件 |

## 1. 事故还原与工作项一（orchestrator 绑定可观测性）

### 1.1 幽灵 socket 根因已修（2026-07-25，`059f386`）

Windows 监听 socket 句柄被 PTY/Web **子进程继承**，父进程退出后子进程仍攥着句柄 → 端口显示 LISTENING 但无人 accept。修复：`socket2` 经 `WSASocketW` 以 `NO_HANDLE_INHERIT` 创建监听 socket（`orchestrator_service.rs`、`cc-panes-web/src/main.rs`），并有 drop-后-可重绑单测。**本文原设想的"退避重试"因此不再是主要手段。**

### 1.2 剩余缺口：绑定失败仍然静默

端口被**第三方程序**真占用时，绑定失败依旧静默——UI 正常、orchestrator 不存在、无任何提示（本次事故中 release 实例即处于此状态）。

- [ ] `OrchestratorStatus` 现仅有 `port`/`bind`；**新增** `lifecycle`（binding/ready/failed）、`attempt`、`lastError`、`nextRetryAt`；
- [ ] 定义前端获取方式（事件 emit 或轮询）、重试取消规则、单实例约束；
- [ ] UI 可见报警（状态栏/横幅 + 逃生阀 `CC_PANES_ORCHESTRATOR_PORT` 指引），**禁止静默降级**（同 CLAUDE.md「降级必须对用户可见」）；
- [ ] 纵深防御：有界退避重试（根因已除，此处只防第三方占用的瞬时态）。
- 验收：人工占用端口 → 启动 → 观察 lifecycle 变化与报警；释放 → 自动恢复。

## 2. cc-panes-ctl 定位

服务端接口早已齐备（orchestrator：18 REST 路由 + `/mcp` 86 工具；daemon：16 HTTP/WS 操作），缺的只是消费端薄壳。一个二进制、两个角色：

| 角色 | 形态 | 解决什么 |
|------|-----|---------|
| 人类/AI 命令面 | `sessions` / `bindings` / `tools` / `call` / `status` | orchestrator 死了也能经 daemon 接管会话 |
| stdio MCP 代理 | `mcp-proxy` | docs/37 方案 C：CLI 配置里不出现端口，根治 MCP 孤儿 |

## 3. 实施清单

### Phase 0：端点发现（~0.4d，前置）

- [ ] **两个独立函数，不合并**：
  - `resolve_orchestrator_endpoint()`：从 cli-hook 抽出，行为**完全不变**（env→探活→`mcp-orchestrator.json`→兜底 env + WSL host 改写），cli-hook 改引用；
  - `discover_daemon_endpoint()`：新增，读 `runtime/daemon-manifest.json`（camelCase `addr/token/pid/startedAt`）；
- [ ] **探活升级为身份核对**：两侧 `/api/health` 都只回 `{"status":"ok"}`，裸 TCP/health 无法辨认对面是谁。核对服务名 + `pid` + `startedAt`（与 manifest 一致才认），日志全链路脱敏 token；
- [ ] **安全边界如实记录**：无法防御能读取同用户 manifest 的恶意进程（同用户即同信任域），文档写明，不假装解决；
- [ ] 数据目录选择：`--dev/--release/--auto` + 自定义数据目录；auto 规则见 §5；
- [ ] 回归护栏：cli-hook 现有行为的测试必须先绿再动（抽取零行为变更）。

### Phase 1：MCP 客户端 + 全工具面（~0.4d）

> 提前到命令面之前——`bindings` 依赖它。

- [ ] MCP HTTP 客户端（streamable HTTP + Bearer + `Mcp-Session-Id`），与 Phase 3 代理**共用**；
- [ ] `tools [--schema <name>]`：运行时 `tools/list`，schema 驱动，服务端加工具零改动同步（**不写死工具数**）；
- [ ] `call <tool> --json '<args>' | --arg k=v`：`tools/call` 通用调用器，`--arg` 按 schema 转型；输出 content 块（`--json` 原样，人读基本美化，不做 per-tool 定制）；
- [ ] 依赖 orchestrator 存活；不可达时报错并指路可用的 daemon 降级子命令。

### Phase 2：命令面（~0.5d）

全局 flag：`--dev/--release/--auto`、`--json`。

| 子命令 | 后端 | orchestrator 死时 | 备注 |
|---|---|---|---|
| `status` | 双源身份核对 | ✅ 主场 | 报告 orch/daemon 各自 lifecycle |
| `sessions list` | orch `/api/sessions`（`{sessions:[…]}`）或 daemon（`Vec<SessionStatusInfo>`） | ✅ daemon | **两种响应结构不同，必须各自反序列化后归一**，不可共用类型 |
| `sessions read <id> [--lines N]` | daemon `/api/sessions/{id}/output` | ✅ 尽力而为 | 仅内存尾部：活会话上限 20000 行/20MiB，死会话仅留 5 分钟，响应无 `truncated`/`availableLines` → **输出必须标注"尽力而为"**，或推动 daemon 补元数据 |
| `sessions submit <id> <text>` | daemon `/api/sessions/{id}/submit` | ✅ 受限 | daemon 侧无 orchestrator 的限流与长 prompt 外置 → ctl 自行限制输入大小并提示差异，不宣称完全等价 |
| `sessions write <id> --key esc\|ctrl-c\|ctrl-d\|cr` | daemon `/write` | ✅ | 控制键白名单映射真字节（杜绝 `\x03` 四字符事故） |
| `sessions kill <id>` | daemon DELETE | ✅ | |
| `bindings list [--stale]` | MCP `query_task_bindings`（只读 SQLite 仅作 orch 死时的降级读） | ⚠️ 受限 | `--stale` 需联查 daemon 活会话；orch 死时标注数据可能不全 |
| `bindings close/reconcile` | MCP `update_task_binding` / `reconcile_plan_collaboration` | ❌ 默认禁止 | 完整 reconcile 还依赖前端 pane/tab 快照，orch 死时**不能宣称等价**；逃生阀见 §4 |
| `launch <project> [--prompt\|--resume]` | orch `/api/launch-task` | ❌ 明确报错 | 不降级 |

- [ ] 输出：人读表格默认，`--json` 给 AI/脚本；错误必须含"试过哪个源、为何失败、下一步建议"；
- [ ] 退出码：0 成功 / 2 源不可达 / 3 参数错 / 4 写冲突。

### Phase 3：mcp-proxy（~1d，最难的一段）

#### 3.1 会话状态机（不是无状态转发）

- [ ] **代理自己终结上游 stdio `initialize`**：保存 client 的 initialize 参数与协议版本；
- [ ] **对下游独立维护会话**：`Mcp-Session-Id`、protocol-version、`notifications/initialized`、**连接代次（generation）**；端点轮换 = 新代次 → 用保存的参数**重新握手**，而非把新 URL 塞进旧会话；
- [ ] **启动时 orchestrator 已不可达**也必须能起：代理独立完成上游握手，工具目录取 **last-known-good 缓存**（持久化）；无缓存则有界等待 initialize，超时给明确错误（开放问题2 决议：A+B）；
- [ ] 重连后若工具集变化 → 发 `notifications/tools/list_changed`；若 CLI 不支持则明确告知需重启会话；
- [ ] **`launchId` 必须透传**：orchestrator 用 `/mcp?launchId=` 做 worker 授权与父子关系（`orchestrator_service.rs:733-778`）。代理接收该参数并附加到下游 URL——**漏了这条派工链直接废**。

#### 3.2 重试语义（at-most-once，不许自动重放）

| 失败类型 | 处理 |
|---|---|
| 连接被拒、DNS/端口不可达、旧 session 404（**明确未执行**） | 可重试 |
| 连接 reset、读超时、响应丢失（**执行状态未知**） | **报告"结果不确定"，禁止自动重放** |

`launch_task`/`submit`/`write` 等有副作用的工具尤其适用后者——重放会导致重复启动会话、重复注入输入。**"永不断线"只适用于连接层，不适用于调用语义。**

#### 3.3 注入链切换与灰度

- [ ] `claude.rs`/`codex.rs` 注入从 http url 改为 stdio proxy 命令，配置开关灰度（默认 off，验证后翻转）；
- [ ] 核证不被 legacy 清理误伤：`claude.rs:358-367` 只匹配 `ccpanes-fixed` 或 command 含 `ccpanes-proxy`；新名 `cc-panes-ctl mcp-proxy` 已避开——**加测试钉死这个边界**；
- [ ] 钉死 Codex `-c` 覆盖仍在 `resume` **之前**，OSC/rollout fallback 不变（docs/45 教训）；
- [ ] 灰度验收矩阵：{local, WSL} × {Claude, Codex} × {新会话, resume} × {proxy on, off} × {skip_mcp} + shared MCP 共存。

### Phase 4：分发（~0.2d）

- [ ] 不止 `build.rs`：还需更新 workspace 成员、`scripts/build-hook.cjs`、`scripts/copy-hook.cjs`、`tauri.conf.json` 的 resources/placeholder；
- [ ] 本地与 WSL 均注入**绝对 sidecar 路径**；
- [ ] WSL 形态（开放问题3 决议）：MVP 走 A——`cmd.exe /C <Windows绝对路径>\cc-panes-ctl.exe mcp-proxy`；**必须验证** stdio 透传、引号转义、取消信号、以及 interop 被禁用时的可读提示；
- [ ] ⚠️ CLAUDE.md 暗雷：`tauri dev` 不重建 external binaries——改动后必须手动 `cargo build` 并拷贝到 `<target-dir>\debug\binaries\`，否则"测试全绿却不生效"。

## 4. 数据红线：bindings 离线写

默认**禁止**（开放问题1 决议：A 为默认 + B 作逃生阀，C 为后续正解）。

- **默认（A）**：orchestrator 不可达时 `bindings close/reconcile` 直接失败，提示等待 orchestrator 或用逃生阀；
- **逃生阀（B）**：`--force-offline-db` 才允许直写，且必须全部满足——精确 schema/`user_version` 校验、`BEGIN IMMEDIATE`、busy timeout、基于 `updated_at`+`status` 的 CAS、字段白名单、事务后回读校验、冲突时退出码 4；
- **必须在文档与命令输出中明示**：直写绕过 `TaskBindingService` 的 update lock、字段校验、事件 emit、leader 通知与补投队列——"参数绑定 UTF-8"只解决编码，不解决这些副作用（编码坑本身见记忆 `sqlite3-cli-gbk-corruption`）；
- **后续正解（C）**：daemon 增加复用 `TaskBindingService` 的认证端点，让离线写也走服务层不变式。本批不做，记为下一件。

## 5. auto 数据目录选择（开放问题4 决议）

- 只读聚合（`sessions list`、`status`）：**A**——两实例都健康时聚合展示并标注 dev/release；
- 写操作（`submit`/`write`/`kill`/`bindings` 写/`launch`）：**B**——歧义时**失败**并要求显式 `--dev`/`--release`。绝不静默替用户选一个执行写操作；
- 在管控会话内可用 `CC_PANES_*` env 直接判定，无歧义。

## 6. 工量与验收

工量：Phase 0 ~0.4d + Phase 1 ~0.4d + Phase 2 ~0.5d + Phase 3 ~1d + Phase 4 ~0.2d ≈ **2.5d**（比评审前估的 1.75d 高，主要来自代理会话状态机与分发链）。

验收：
1. 杀掉 orchestrator → `status`/`sessions *` 经 daemon 照常工作，且受限项如实标注（不谎报等价）；
2. 注入 mcp-proxy 的 Claude/Codex 会话在 CC-Panes 重启（端口/token 轮换）后 MCP 工具不断线；`launchId` 相关的 worker 授权与父子关系仍成立；
3. 代理在"orchestrator 启动即不可达"下能起，缓存目录可用，恢复后自动续接；
4. 有副作用的工具在 reset/超时后**不自动重放**，返回"结果不确定"；
5. `bindings` 默认拒绝离线写；逃生阀路径的 CAS/校验/回读全覆盖；
6. 灰度矩阵（§3.3）全绿；cli-hook 回归测试零变更通过；
7. 常规检查：`npx tsc --noEmit`、`cargo clippy --workspace -- -D warnings`（**注意用 PIPESTATUS 取真实退码，别被 tail 掩码**）、`cargo fmt --all -- --check`、定向测试。
