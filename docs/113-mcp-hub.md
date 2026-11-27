# 113 · 共享 MCP 聚合入口 `ccpanes-hub`

> 状态：实验功能，默认关闭（`experimental.mcpHub`，Dev 也关）。
> 参考：magpie `docs/subsystems/mcp-router.md`（Tools on demand / call 规则）；本仓库 docs/89（工具面收编）、docs/70（共享 MCP 进程）。

## 1. 要解决的问题

每个 agent 启动时，共享 MCP 一台一条地注入，`tools/list` 里所有工具的 name + description + inputSchema 都进上下文。实测（维护者本机，`node scripts/mcp-hub-token-compare.mjs`，2026-11-27）：

| 服务器 | 工具数 | 定义字节 | ≈tokens |
|---|---:|---:|---:|
| chrome-devtools | 33 | 30285 | 7571 |
| cc-memory | 5 | 2983 | 746 |
| wechat | 7 | 4125 | 1031 |
| **全量注入合计** | **45** | **37393** | **≈9348** |
| **只注入 hub** | **2** | **715**（含 instructions 87） | **≈179** |

节省 36678 字节（98.1%）。口径：每个工具的 `{name, description, inputSchema}` 紧凑 JSON 字节数，token ≈ 字节 / 4（JSON + 英文描述时的常用近似；中文描述会低估）。docs/18 没有可复用的测量公式，这里自定口径，脚本可重复跑。

代价不在启动时而在使用时：每次 `search_tools` 返回的结果带完整 inputSchema（默认最多 10 条），用到哪个工具才为哪个工具付费。

## 2. 形状

```
agent ──HTTP──▶ orchestrator /mcp-hub?token=…&servers=a,b   （rmcp StreamableHttpService）
                     │  McpHubHandler（src-tauri/src/services/mcp_hub_handler.rs）
                     ▼
               McpHubService（cc-panes-core/src/services/mcp_hub/）
                     │  缓存 + 检索 + 转发（reqwest，Streamable HTTP 客户端）
                     ▼
     共享 MCP：本地桥 http://127.0.0.1:<port>/mcp ／ 远程 MCP（transport=http）
```

对外只有两个工具（定义单源 `mcp_hub/hub_tools.json`，handler 与对比脚本都读它）：

- `search_tools(query, limit?)`：在本会话可见的服务器的工具里检索，返回 `{tools:[{server, tool, summary, inputSchema}], unavailable?:[{server, error}]}`。没命中时附一句 hint。
- `call_tool(server, tool, arguments)`：转发，后端的 `CallToolResult` 原样回传。`arguments` 也接受「装着对象的字符串」（部分模型会多序列化一次）。

### 2.1 为什么挂在 orchestrator 上，而不是 SharedMcpService 再起一个端口

- 共享 MCP 进程归 app 所有（daemon 模式下 daemon 只拿到推送的 URL 表），orchestrator 也在 app 里，两者同进程，`AppState` 里已有 `shared_mcp_service`。
- 鉴权白拿：路径以 `/mcp` 开头，现有 `mcp_auth_middleware` 的 Bearer / `?token=` 校验直接覆盖。hub 会把调用转给带密钥请求头的远程 MCP，不能像本地桥那样裸奔在 127.0.0.1。
- 生命周期一致：hub URL 和 ccpanes 注入用同一组 port/token，orchestrator 不健康时两者一起不注入。

### 2.2 会话可见范围：URL 上的 `servers=`

hub 不知道「是哪个启动档在问」。注入时把本次启动档筛选后的服务器名写进 URL（`servers=a,b`，逐项 URL 编码），handler 按它过滤检索和调用。于是开 hub 和不开 hub 时，agent 能用的服务器集合一致，只是形态变了。缺参数视为不限制（手动接入时方便）；`servers=` 为空即一个都看不到。

## 3. 缓存与刷新

- 按服务器缓存工具清单，键带**指纹**：URL + 请求头 + 本地进程 PID（sha256）。服务器重启（PID 变）、改配置（URL / 请求头变）都会丢掉旧缓存和旧 MCP 会话，下次检索重新握手、重拉。
- TTL 10 分钟，兜住「服务器换了工具却没通知」。没有开 GET 事件流听 `notifications/tools/list_changed`：那要为每台后端常驻一条流并处理重连，收益不抵复杂度；magpie 也只对「另一台路由器」开流，普通服务器同样靠缓存。
- 拉新失败但手里有旧清单 → 先用旧的（记 warn），下次再试；从没拉成功过 → 这台出现在 `unavailable` 里，如实告诉模型，而不是静默少一截工具。
- 后端回 404（会话被遗忘，多半是重启）：重新握手后重试**一次**——请求没进工具执行，重试安全。其余传输错误不重试（执行状态未知）。

### 3.1 缓存里没有的工具照样转发

对齐 magpie 那条规则（「a tool its server no longer lists still goes to that server」）：`call_tool` 只校验**服务器**——在运行、对本会话开放——不校验工具是否在缓存里。理由：

- 缓存可能落后于服务器（刚新增的工具、动态注册的工具），拦下来就是误杀；
- 工具真不存在时，服务器自己会回错误，比 hub 的猜测更准；
- 转发了缓存外的工具，就把该服务器的缓存标成过期，下次检索自然重拉。

服务器本身不在（没启用、没运行、不在本会话 `servers` 里）则直接拒绝，不去碰任何后端。

## 4. 检索

纯函数 `mcp_hub/search.rs`，不引外部依赖：

- 关键词：按非字母数字切分，`_` `-` 再拆；单个 ASCII 字母丢弃；CJK 整段保留做子串匹配。
- 打分：名字等于整个查询（或 `server/name`）+10；名字含词 +3，否则名字上的子序列模糊命中（≥3 字符）+1；服务器名含词 +2；描述含词 +1。
- 多关键词至少命中一半才算匹配：避免「send email」把所有含 send 的工具都拉出来（magpie 踩过同一个坑）。
- 空查询 = 按服务器、名字列出全部（仍受 limit，默认 10、上限 50）。
- `summary` 取描述第一句（`.` 后接空白才算句末，避免切断 `v1.2`），最长 160 字符。

## 5. 注入路径（开关与启动档）

两道闸，都关着时行为与旧版逐字一致：

1. 设置 → 实验功能 → 「共享 MCP 聚合入口」（`experimental.mcpHub`，`#[serde(default)]` = false，不走 `default_experimental_flag`，Dev 也关）。
2. 启动档 MCP 卡片里出现「只注入 ccpanes-hub」（`mcpPolicy.useMcpHub`，`skip_serializing_if` false——不勾时 launch-profiles.json 不多一个字段）。只在开关打开、MCP 非全关、勾了共享 MCP 时显示。

生效点在 `terminal_service.rs` 的**本地**分支、构造 `CliAdapterContext` 之前（`launch_uses_mcp_hub` + `mcp_hub::apply_hub_injection`）：

- 前置：开关开 + 启动档勾选 + CLI 是 Claude / Codex + orchestrator 健康（拿得到 port/token）。
- 把 `effective_shared_mcp_urls`（已经过启动档筛选与 `retain_supported_remote_mcp`）里 hub 能代转的服务器收进一条 `ccpanes-hub`；`sse` 远程 MCP 留在原表照旧直连（hub 只会说 Streamable HTTP）。
- 被收进 hub 的名字放进新字段 `CliAdapterContext::hub_covered_mcp_servers`，adapter 据此去重：
  - Claude：`~/.claude.json` 与工作空间层里同名的那份不再合并进 `--mcp-config`。
  - Codex：用户 `config.toml` 里**确实存在**的同名段显式 `enabled=false`（对不存在的名字写 `enabled=false` 会凭空造出缺 command/url 的表，Codex 启动报错）。

  不去重的后果是 hub 与原服务器并排出现，上下文反而更大——共享 MCP 多是从 `~/.claude.json` 一键导入的，同名极常见（magpie 的 Col0urfu1_ 事故同理）。
- 用户自己有一台叫 `ccpanes-hub` 的共享服务器时放弃改写，避免顶掉它。

### 5.1 刻意不做的

| 不做 | 原因 |
|---|---|
| WSL / SSH 会话走 hub | WSL 分支对 URL 有自己的主机改写与 Codex 专线，SSH 没有 orchestrator；先只做本地，行为最可预期 |
| 其余 CLI（Gemini、OpenCode、Pi…）走 hub | 它们的「用户全局同名」去重各不相同，没做去重就开 hub 会让工具出现两次；勾了也照旧逐个注入 |
| 监听 `tools/list_changed` 事件流 | 见 §3 |
| 工具名平铺（`server__tool`）直接列出 | 那就回到全量注入，失去意义；Claude Code 自带 tool search 时全量列出更合适，但我们不能假设每个 CLI 都有 |
| 进度 / 日志通知透传 | 后端的 `notifications/progress` 不转回 agent；长调用只能等结果 |

## 6. 已知局限

- 「更换令牌」后，已启动会话里的 hub URL 和 ccpanes URL 一样失效，需要重启会话。
- Claude Code 开着自带 tool search 时，全量注入的工具本就会被延迟加载，hub 的收益主要在没有 tool search 的 CLI / 版本上；但多一层 hub 也不吃亏（启动只占 ~180 tokens）。
- hub 单会话内调用不持锁（共享后端 MCP 会话 id，JSON-RPC id 全局递增），但同一后端的「握手 / 拉清单」串行。

## 7. 验证

```bash
# core：检索 / 注入改写 / 端到端（手写 Streamable HTTP mock 后端）
CARGO_TARGET_DIR=… cargo test -p cc-panes-core --lib -- mcp_hub mcp_hub_applies mcp_hub_experiment
# adapter 去重
CARGO_TARGET_DIR=… cargo test -p cc-cli-adapters -- hub_covered
# handler（工具定义可被 rmcp 解析、arguments 宽松解析）
CARGO_TARGET_DIR=… cargo test -p cc-panes --lib -- mcp_hub_handler
# 前端开关 / 启动档勾选项
npx vitest run web/components/providers/LaunchProfileMcpCard.test.tsx
# 体积对比（只发 initialize + tools/list，不调用工具）
node scripts/mcp-hub-token-compare.mjs [--data-dir ~/.cc-panes-dev] [--url name=http://…] [--json]
```

端到端测试覆盖：跨服务器检索 + 缓存命中不重拉、`servers=` 限定可见性、缓存外工具照样转发并让缓存过期、停用 / 不存在的服务器被拒、改配置后重握手重拉、连不上的服务器出现在 `unavailable`。

需要真机验证：开关 + 启动档勾选后，本机 Claude Code / Codex 会话里只出现 `ccpanes-hub`（加 `ccpanes`），`search_tools` → `call_tool` 能打通 mcp-proxy 桥和远程 MCP。
