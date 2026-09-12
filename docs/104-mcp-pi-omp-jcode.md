# 104 · pi / omp / jcode 接入 MCP 注入

> 2026-09-12。让「设置 → 工具 → 运行配置」的 MCP 策略对 pi / omp / jcode 真正生效：
> 启动会话时把工作空间/项目层 mcp.json + 共享 MCP + ccpanes 内置编排器注入这三个 CLI。
> 此前它们的 `supports_mcp` 能力位为 false，运行配置里整卡显示「不支持」。

## 0. 结论速览

| CLI | 上游 MCP 事实（本机取证） | 注入路线 |
|-----|--------------------------|---------|
| **omp** v17.3.8 | **原生全量**（stdio/HTTP/SSE/OAuth）。项目层读 `<项目>/.omp/mcp.json`（`mcp.enableProjectConfig` 默认 true），格式与 Claude 同形 `{"mcpServers":{...}}`，schema 见包内 `src/config/mcp-schema.json`。无 per-launch flag | 启动时收据驱动同步项目 `.omp/mcp.json`：层条目 stdio+http 原样、共享 MCP 走 HTTP 桥 URL、ccpanes 走 HTTP + `Authorization` header |
| **jcode** | 原生**实时读取** `.jcode/mcp.json` / `.mcp.json` / `.claude/mcp.json`（Claude 兼容），**仅 stdio**（http/sse 解析后跳过）。`--mcp-tools` 只是暴露模式（auto/eager/deferred，默认 auto），不是启停开关（实机 --help 确认） | 同步项目 `.jcode/mcp.json`：层条目取 stdio 型、共享 MCP 取**原始 stdio 定义**（绕过 HTTP 桥）、ccpanes 走 `cc-panes-ctl mcp-proxy` stdio 包装 |
| **pi** v0.85.1 | **无 MCP**（自有代码零 MCP 字符串；仅 Gemini SDK proto 字段撞词）。官方哲学 = 扩展系统替代 | **扩展桥**：单文件零依赖扩展 `ccpanes-mcp.js`（include_str 内嵌）落进 extensions 目录 + per-session 配置 + `CCPANES_MCP_CONFIG` env；扩展把每个 server 的工具注册为 pi 原生工具 `mcp__<server>__<tool>` |

取证方法：omp 真身在 `~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent`
（`omp.exe` 只是 15KB shim）；pi 在 npm 全局 `@earendil-works/pi-coding-agent`
（bundle/chunks 全量 grep）；jcode 二进制字符串 + `--help`。

## 1. 数据流

```
运行配置(mcpPolicy) ─┐
工作空间/项目层 mcp.json ─┤ terminal_service.create_session
共享 MCP（URL 表 + 原始 stdio 定义*） ─┤   ├─ effective_skip_mcp / allowed_ids / isolate
ccpanes 编排器（port+token / ctl proxy*） ─┘   ↓
                                    CliAdapterContext
                        （* 新增 shared_mcp_stdio 字段；ctl proxy 门控扩到 Jcode）
                                       ↓ build_command
        ┌──────────────┬──────────────────────┬─────────────────────┐
        omp.rs          jcode.rs                pi.rs
        .omp/mcp.json   .jcode/mcp.json         <data>/mcp-pi-<sid>.json
        （收据驱动）     （收据驱动）             + <agentDir>/extensions/ccpanes-mcp.js
                                                + env CCPANES_MCP_CONFIG
```

合并优先级（低→高，与 claude.rs per-session 合并一致）：
层条目 < 共享 MCP < ccpanes。`ccpanes` 是保留名，层里同名条目被接管。

## 2. 收据驱动的所有权（mcp_file_injection.rs）

项目级文件是**工具自有领地**（用户可能自己配过），注入必须可辨识、可回滚：

- 收据：`<项目>/.ccpanes/.cache/mcp-injected-<cli>.json`（机器本地，`.ccpanes/.gitignore`
  守卫覆盖）。记录我方写过的 server 名集合。
- 同步规则：收据内名字可 upsert/移除；收据外同名条目 = 用户所有 → 跳过并 warn
  （foreign collision）；其他顶层键（`$schema` 等）与用户条目原样保留。
- 幂等：解析后的 JSON 语义不变 → 零写入（不刷 mtime、不产生 .bak）。
- 损坏即停：目标文件解析失败 → 原样保留只 warn；收据损坏 → 视为空（保守：既有
  条目全部按用户所有处理，宁可不更新也不覆盖）。
- 原子写 + 改动前 `.bak` 单槽备份。
- **skip_mcp / 策略关闭 = 用空集合同步** → 收据内条目全部移除。omp/jcode 实时读
  文件，残留 = 继续注入，必须清。
- gitignore 守卫：`.omp/.gitignore`、`.jcode/.gitignore` 落 `mcp.json`/`mcp.json.bak`
  规则（ccpanes URL 带 token，绝不能进库）；用户已写过覆盖规则的不碰。

## 3. per-CLI 细节与降级

### omp
- ccpanes HTTP 条目**不附 `&launchId=`**：项目级文件被同项目所有会话共享，附上
  只会让最后一次启动冒充全部会话的 caller 身份（与 grok 模块头同一降级判断）。
- 隔离模式（disable_unlisted）v1 不支持：omp 还会从 `.claude/.cursor/.codex` 等
  外部配置导入 server，没有逐源禁用通道 → warn 降级（grok 同款）。v2 候选：
  omp 支持项目层 `enabled:false` 同名压制（changelog #7652）。
- 用户若在 omp 设置里关了 `mcp.enableProjectConfig`，注入静默失效（上游行为）。

### jcode
- http/sse 型层条目跳过（写了也会被 jcode 跳过，只会污染文件），warn 计数。
- 共享 MCP 服务器本质是 stdio 源经 HTTP 桥暴露 → 直接注入原始
  `{command,args,env}`（`ctx.shared_mcp_stdio`，terminal_service 从
  SharedMcpConfig ∩ 运行中 URL 表构建）。HTTP 原生型共享服务器无 stdio 源 → 跳过。
- ccpanes 依赖 ctl mcp-proxy：门控对 Jcode **强制启用**（不受 `CCPANES_MCP_PROXY`
  灰度开关约束——jcode 没有"维持原连接方式"的选项）；ctl 缺失只 warn 降级
  （ccpanes 条目缺席），绝不阻断开终端。

### pi（扩展桥）
- 扩展落点：托管启动 → `<PI_CODING_AGENT_DIR>/extensions/`（隔离 agent root，
  与 inject_managed_pi_skills 同一目录树）；原生启动 → `~/.pi/agent/extensions/`
  （内容比对幂等）。发现路径由 pi loader 实证：`<cwd>/.pi/extensions` +
  `<agentDir>/extensions`，jiti 加载，default export 工厂可为 async。
- per-session 配置 `<data_dir>/mcp-pi-<session>.json`：命名兼容 claude.rs 的
  `mcp-*.json` 1h GC 循环，另有自己的同款 GC。扩展启动时读一次，之后文件被
  GC 也不影响运行中的会话。
- env `CCPANES_MCP_CONFIG`：每次 build_command 先无条件 env_remove（隔离环境
  残留），激活时再注入。**无该 env 扩展完全惰性**——用户在 CC-Panes 之外手动
  跑 pi 不受任何影响。
- 桥内最小 MCP 客户端（零 npm 依赖）：stdio（Windows 走 shell:true + 手工引号，
  解决 npx.cmd 解析与 Node 的 .cmd spawn 限制）+ Streamable HTTP（POST +
  `Mcp-Session-Id` + SSE 响应解析 + Authorization header）。legacy SSE 传输未实现
  （跳过并 stderr 告警）。
- 工具名 `mcp__<server>__<tool>`（非法字符替换为 `_`，>64 字符截断 + 稳定哈希）。
- 失败隔离：单 server 连接失败/超时（15s）不影响其他 server 与 agent 启动；
  `registerTool` 缺失（API 漂移）→ 整体 no-op。**只用 stderr**（`--mode rpc` 下
  stdout 是 JSONL 协议通道，console.log 会打爆 RPC 流）。
- RPC 启动链（build_pi_rpc_launch_spec）固定 `skip_mcp: true` → 桥休眠（v1 范围
  决策：RPC 后台任务不注入 MCP）。
- 隔离模式：只能收窄 CC-Panes 管理的集合；用户自己装进 ~/.pi 的扩展/工具无禁用
  通道 → warn。

## 4. 前端解禁

- `LaunchProfileMcpCard`：硬编码排除名单（pi/omp/jcode）→ **能力驱动**
  （`useCliTools` 的 `supportsMcp`，能力缺失按支持处理——口径同
  launcherCapabilities「用能力声明禁用实际可用的功能比不置灰更糟」）。
  纠错副作用：gemini/kimi（后端能力位本就 false）从「显示可配」变为「不支持」。
- per-CLI 提示：pi 显示「扩展桥/实验性」提示，jcode 显示「仅 stdio」提示
  （i18n `mcpBridgePiHint` / `mcpStdioOnlyJcodeHint`）。
- `launchInjectionSummary`：MCP_UNSUPPORTED_CLIS `{pi,omp}` → `{gemini,kimi}`
  （与后端能力位对齐）。
- `LauncherChips`：YOLO / 禁 MCP 拆分门控——YOLO 按 `supportsYolo === false`
  隐藏（顺带修复 opencode/kimi/gemini 的 YOLO chip 点了没用），禁 MCP 按
  `supportsMcp === false` 隐藏（pi/omp/jcode 恢复显示，skip_mcp 现在对三者有
  真实语义：清残留注入）。
- `can_report_task_result`（默认 = supports_mcp）：jcode 翻真——ccpanes core
  工具集含 report_to_leader，jcode 经 ctl 代理确实可上报；omp/pi 各有显式
  override（structured_result）不受影响。编排启动门（supports_orchestrated_launch）
  不动，omp/jcode 仍不可被 dispatch。

## 5. 边界

- **WSL**：v1 不注入。WSL 链路在 wsl_codex.rs 独立拼命令、不经 adapter
  build_command，天然不触发；侧栏 WSL partial 徽章维持原语义。v2 候选：omp
  原生支持 HTTP，宿主经 `\\wsl$` 写 HTTP-only 集合即可。
- **SSH**：维持全禁（create_session SSH 分支明确跳过 MCP 注入；pi/omp/jcode
  前端本就 local/wsl-only）。
- **ACP / Agent Chat**：不在本文范围——pi-acp 桥与 jcode acp 已通过
  session/new 的 mcpServers 参数拿 ccpanes（docs/94）。
- 同项目并发会话竞写 `.omp/.jcode/mcp.json`：后写覆盖（与 grok 全局条目同级
  降级），收据保证不丢用户数据。

## 6. 验证矩阵

| 层 | 手段 | 状态 |
|----|------|------|
| 收据合并/清理/守卫/损坏降级 | mcp_file_injection.rs 16 项单测 | ✅ |
| omp 注入/skip 清理/用户条目保护 | omp.rs 3 项 + 能力位断言 | ✅ |
| jcode stdio-only/无代理降级/skip 清理 | jcode.rs 3 项 + 能力位断言 | ✅ |
| pi 托管注入/skip 休眠/GC/落点解析 | pi.rs 5 项 + 能力位断言 | ✅ |
| 桥协议层（stdio spawn/工具注册/调用/isError/惰性守卫） | mock MCP server 冒烟（node driver） | ✅ |
| 前端卡片/摘要/chips | LaunchProfilesPanel + launchInjectionSummary 测试 | ✅ |
| 实机：omp `/mcp` 列出注入 server | mock server 连接日志 | ✅ 原生发现 `.omp/mcp.json`，完整握手 initialize→initialized→tools/list（用户默认 provider opencode-go 在纯 CLI 下 400，属上游路由限制，与注入无关） |
| 实机：jcode MCP 工具可见可调用 | `jcode run` 真调用 | ✅ 工具注册为 `mcp__mock__echo`（jcode 同款命名），调用返回正确；无需任何启用开关 |
| 实机：pi 工具列表出现 `mcp__*` 并可调用 | `pi -p -e <bridge>` 真调用 | ✅ stderr `1 tool(s) bridged`，模型调用 `mcp__mock__echo` 成功返回 |

实机冒烟前置：重建侧车四件套 + copy-hook + 镜像 debug/binaries + 杀旧 daemon
（AGENTS.md「Sidecar sync」铁律，旧 daemon 会把新 CLI 行为静默吞掉）。

## 7. v2 backlog

- omp 隔离压制（项目层 `enabled:false` 同名覆盖，含压制外部导入源）
- pi legacy SSE 传输、pi RPC 链注入
- WSL：omp HTTP-only 注入；jcode 需 guest 内 ctl，暂缓
- preview warnings 补「jcode 将跳过 N 个 HTTP 型条目」（本次仅适配器 warn 日志 +
  卡片提示文案覆盖）
- 桥扩展的 vitest 协议层测试（当前由 node driver 冒烟覆盖；扩展文件在
  cc-cli-adapters/resources/，跨出 web/ 的 vitest root，需要 alias 配置）
