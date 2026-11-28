# 113 · MCP Hub（`ccpanes-hub`）：共享 MCP 的统一入口

> 参考：magpie `docs/subsystems/mcp-router.md`（Tools on demand / call 规则）。相关：docs/103（ccpanes 自身 MCP 精简）、docs/109（资源库）、docs/110（CLI 注入描述单源）。

## 1. 概念

资源库里的共享 MCP（第三方服务器：chrome-devtools、memory、远程 MCP…）有两种**投递方式**交给会话：

- **直连**（`direct`，默认，旧行为）：每台服务器各一条条目，所有工具定义启动时进上下文。
- **Hub**（`hub`）：只给一条 `ccpanes-hub`，它只暴露 `search_tools(query, limit?)` 与 `call_tool(server, tool, arguments)`，背后是同一批共享服务器。

投递方式是启动档 `mcpPolicy.delivery`，与 `mcpPolicy.mode`（default / custom / disabled，管「给哪些」）**正交**：mode 决定这次会话能用哪几台服务器，delivery 决定这几台以什么形态出现。Hub 不改变可用集合——注入 URL 上的 `servers=` 就是 mode 筛选后的结果。

Hub 的价值按重要性排：

1. **一个统一入口**：资源库 MCP 页顶部的 Hub 卡片显示端点、背后聚合了几台服务器 / 多少工具、哪些启动档在用 Hub 投递。共享 MCP 从「每个会话各自一份」变成看得见、管得住的一个点。
2. **可控**：Hub 是我们自己的代码，转发、缓存、可见范围、失败如实上报（`unavailable`）都在一处。
3. **省 token**：对没有原生延迟加载的 CLI（Codex 等）收益大；对 Claude Code 收益小（见 §3）。

### 1.1 与 docs/103 的关系

docs/103 处理的是 **ccpanes 自己的 MCP**：`/mcp` 只放 core 常驻工具，`/mcp-full` 给 ctl / UI，管理面下沉到 `cc-panes-ctl`。Hub 处理的是**第三方共享服务器**这一层，两者不重叠：

| 端点 | 内容 | 谁用 |
|---|---|---|
| `/mcp` | ccpanes core 工具（会话、派发、编排…） | 每个会话的 `ccpanes` 条目 |
| `/mcp-full` | ccpanes 全量工具 | cc-panes-ctl、UI |
| `/mcp-hub` | 共享 MCP 的 `search_tools` / `call_tool` | 选了 Hub 投递的会话的 `ccpanes-hub` 条目 |

三者挂在同一个 orchestrator、同一套 Bearer / `?token=` 鉴权上。`ccpanes` 条目从不进 Hub（它本身已经是 core 精简面）。

### 1.2 与 Claude Code 原生 tool search 的关系

Claude Code 原生支持 MCP tool search：工具多时启动只给模型看工具名，schema 用到才取。所以对 Claude，「全量注入」不是真实基线，Hub 在 token 上只比原生延迟加载多省一点（§3）。Hub 对 Claude 的意义主要是统一入口与可控；对 Codex 这类会把每个工具完整定义都塞进上下文的 CLI，Hub 才同时是省 token 的手段。启动档 MCP 卡片的说明文案就是这么写的。

## 2. 形状

```
会话 ──HTTP──▶ orchestrator /mcp-hub?token=…&servers=a,b   （rmcp StreamableHttpService）
                    │  McpHubHandler（src-tauri/src/services/mcp_hub_handler.rs）
                    ▼
              McpHubService（cc-panes-core/src/services/mcp_hub/，app 管理的单例）
                    │  缓存 + 检索 + 转发（reqwest，Streamable HTTP 客户端）
                    ▼
    共享 MCP：本地桥 http://127.0.0.1:<port>/mcp ／ 远程 MCP（transport=http）
```

- `McpHubService` 在 `lib.rs` 建一份、`manage` 起来；orchestrator 的 `/mcp-hub` 与资源库的 `get_mcp_hub_status` 命令共用它，所以卡片上的工具数就是 Hub 实际缓存的数。
- 工具定义单源 `mcp_hub/hub_tools.json`（handler 与对比脚本都读）。
- `search_tools` 返回 `{tools:[{server, tool, summary, inputSchema}], unavailable?:[{server, error}]}`；没命中附一句 hint。`call_tool` 把后端的 `CallToolResult` 原样回传；`arguments` 也接受「装着对象的字符串」。

### 2.1 为什么挂在 orchestrator 上

- 共享 MCP 进程归 app 所有（daemon 只拿推送的 URL 表），orchestrator 也在 app 里，同进程。
- 鉴权白拿：路径以 `/mcp` 开头，`mcp_auth_middleware` 直接覆盖。Hub 会转发到带密钥请求头的远程 MCP，不能像本地桥那样裸奔。
- 生命周期一致：Hub URL 与 `ccpanes` 用同一组 port/token；orchestrator 不健康时两者都不注入，Hub 投递的会话就是直连。

## 3. 测量（诚实口径）

脚本 `node scripts/mcp-hub-token-compare.mjs`（只发 initialize + tools/list，不调用工具），维护者本机三台共享服务器，2026-11-27：

| 口径 | 适用 | 启动时字节 | ≈tokens（字节/4） |
|---|---|---:|---:|
| 全量注入（45 个工具的 name+description+inputSchema） | Codex 等无原生延迟加载 | 37393 | ≈9348 |
| Claude 原生延迟加载（只见工具名，估下限） | Claude Code 开着 tool search | 1529 | ≈382 |
| 只注入 Hub（2 个工具 + instructions 87 字节） | Hub 投递 | 715 | ≈179 |

- 对 Codex：启动省 ≈98%。
- 对 Claude：相对原生延迟加载只省 ≈800 字节（≈200 tokens）；原生是否启用、阈值多少随 Claude Code 版本与设置变化，脚本按工具名列表估的是下限。
- Hub 的代价在使用时：每次 `search_tools` 返回命中工具的完整 schema（默认最多 10 条），而且多一跳转发。字节 / 4 对中文描述会低估。

## 4. 缓存与刷新

- 按服务器缓存工具清单，键带**指纹**：URL + 请求头 + 本地进程 PID（sha256）。重启（PID 变）、改配置（URL / 请求头变）都会丢掉旧缓存和旧 MCP 会话。
- TTL 10 分钟，兜住「换了工具却没通知」。不开 GET 事件流听 `tools/list_changed`：每台后端常驻一条流加重连，收益不抵复杂度。
- 拉新失败但有旧清单 → 先用旧的（warn）；从没拉成功过 → 出现在 `unavailable`，如实告诉模型。
- 后端回 404（会话被遗忘，多半重启）：重新握手后重试**一次**（请求没进工具执行）；其他传输错误不重试（执行状态未知）。
- **缓存里没有的工具照样转发**（对齐 magpie「a tool its server no longer lists still goes to that server」）：`call_tool` 只校验服务器在运行、对本会话开放，不校验工具是否在缓存里；转发后把该服务器缓存标为过期。缓存可能落后（新增 / 动态注册的工具），拦下来就是误杀；工具真不存在时服务器自己会回错误。
- 资源库卡片只读缓存（`McpHubService::status`），不触发拉取；还没被检索过的服务器显示「首次检索时拉取」。

## 5. 检索

纯函数 `mcp_hub/search.rs`：关键词按非字母数字切分、`_` `-` 再拆，CJK 整段做子串；名字等于整个查询 +10、名字含词 +3（否则名字子序列模糊 +1）、服务器名 +2、描述 +1；多关键词至少命中一半（避免「send email」拉出所有含 send 的工具）；空查询列全部；`summary` 取描述第一句、最长 160 字符。

## 6. 回退规则（前后端同源）

选了 Hub 不等于一定走 Hub。下列组合**自动回退直连**，规则跟 `remote_mcp_supported` / `remoteUnsupportedByProfile` 同一套机制——读 CLI 注入描述（docs/110），前后端各一份实现、用同一组用例钉住：

| 条件 | 后端 | 前端 |
|---|---|---|
| CLI 没声明 `mcp.hub`（目前只有 Claude / Codex 声明） | `InjectionProfile::hub_delivery_supported` | `hubDeliverySupported` |
| 运行时是 WSL / SSH | 同上（`runtime(..).is_some()` 即不支持） | 同上 |
| `sse` 远程服务器（Hub 只会说 Streamable HTTP） | `mcp_hub::hub_can_route`，留在原表直连 | `hubCanRoute` |
| orchestrator 不健康 / 拿不到 port·token | `apply_hub_injection` 不执行 | Hub 卡片显示端点未运行 |
| 用户自己有一台叫 `ccpanes-hub` 的共享服务器 | 放弃改写 | — |

为什么只有 Claude / Codex 声明 `mcp.hub`：Hub 覆盖的服务器常常也在用户自己的配置里（共享 MCP 多是从 `~/.claude.json` 一键导入的），adapter 必须把同名那份去重，否则工具和 Hub 并排出现两次，上下文反而更大。这两家已经做了（`CliAdapterContext::hub_covered_mcp_servers`）：

- Claude：`~/.claude.json` 与工作空间层同名条目不再合并进 `--mcp-config`。
- Codex：用户 `config.toml` 里**确实存在**的同名段显式 `enabled=false`（对不存在的名字写会凭空造出缺 command/url 的表，Codex 启动报错）。

其余 CLI 补上去重后，在它的 `injection_profile()` 里把 `hub` 置 true，并同步 `web/lib/cliInjectionProfiles.json`（`web_fallback_matches_registry_profiles` 会报出来）。

前端呈现：启动档 MCP 卡片在模式旁边放「直连 / Hub」二选一（MCP 全关时不显示）；当前 CLI 不支持时 Hub 置灰，已选 Hub 的启动档显示「回退直连：原因」；本机有 WSL / SSH 运行时、或资源库里有 sse 服务器时各列一行说明。资源库 Hub 卡片在 Hub 投递的启动档旁标出「此 CLI 回退直连」（`hubFallsBackForProfile`）。

## 7. 配置与兼容

- `LaunchProfileMcpPolicy.delivery: McpDelivery`（`direct` | `hub`），缺省 `direct`，旧启动档照常加载。
- 早期分支写过的 `useMcpHub: true` 读取时迁成 `delivery: hub`（`LaunchProfileMcpPolicyWire`）；显式 `delivery` 优先；写回时旧字段消失。
- 没有全局开关：没人选 Hub 时，注入路径与旧版完全一致；`/mcp-hub` 常驻但只有被注入的会话会连。

## 8. 刻意不做的 / 已知局限

| 不做 | 原因 |
|---|---|
| WSL / SSH 走 Hub | WSL 有自己的主机改写与 Codex 专线，SSH 没有 orchestrator |
| 监听 `tools/list_changed` | 见 §4 |
| 平铺成 `server__tool` 全量列出 | 那就回到全量注入；Claude 的原生 tool search 已经覆盖这条路 |
| 进度 / 日志通知透传 | 长调用只能等结果 |

- 「更换令牌」后，已启动会话里的 Hub URL 与 `ccpanes` URL 一样失效，需重启会话。
- 同一后端的握手 / 拉清单串行；调用本身不持锁（共享 MCP 会话 id，JSON-RPC id 全局递增）。

## 9. 验证

```bash
CARGO_TARGET_DIR=… cargo test -p cc-panes-core --lib -- mcp_hub mcp_delivery
CARGO_TARGET_DIR=… cargo test -p cc-cli-adapters -- hub
CARGO_TARGET_DIR=… cargo test -p cc-panes --lib -- mcp_hub_handler
npx vitest run web/components/providers/LaunchProfileMcpCard.test.tsx web/components/resources/McpHubCard.test.tsx web/lib/cliInjectionRules.test.ts
node scripts/mcp-hub-token-compare.mjs [--data-dir ~/.cc-panes-dev] [--url name=http://…] [--json]
```

需要真机验证：Codex / Claude 启动档切到 Hub 后，会话里只出现 `ccpanes` + `ccpanes-hub`，`search_tools` → `call_tool` 能打通 mcp-proxy 桥与远程 MCP；资源库卡片的工具数在第一次检索后出现。
