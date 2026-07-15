# 21 - xAI Grok CLI（Grok Build）接入

> 新增第 8 种 CLI 工具：xAI 官方 Grok CLI（产品名 Grok Build），全量对齐 codex 的接入深度
> （启动、Provider env、resume、MCP 注入、hooks 事件映射、YOLO、launch history）。

## Grok Build 关键事实（实机核对 grok 0.2.101）

| 项目 | 结论 |
|------|------|
| 安装 | npm `@xai-official/grok`，binary `grok`（Windows npm shim 由 `rewrite_windows_npm_shim` 处理，同 gemini/kimi） |
| 认证 | `XAI_API_KEY` 环境变量；OAuth token 在 `~/.grok/auth.json` |
| 配置 | `~/.grok/config.toml`（TOML），`$GROK_HOME` 可覆盖；项目级 `.grok/config.toml` |
| resume | `--resume <id>`；`-c/--continue`；**`--session-id <uuid>` 只用于新会话命名**（必须合法 UUID 且不存在），与 `--resume` 互斥 |
| YOLO | `--always-approve`（另有 `--permission-mode bypassPermissions`） |
| 系统提示词 | **`--rules <RULES>`**（追加到 system prompt，--help 原文确认） |
| 初始 prompt | 位置参数 `grok "..."`；headless 用 `-p` |
| MCP | 无 `--mcp-config` / `-c key=val` override（`-c` 被 `--continue` 占用）；唯一注入面是 config.toml `[mcp_servers.<name>]`，schema：`url = "..."` + `enabled = true`（`grok mcp add` 实测生成）；支持 stdio/http/sse |
| Harness 兼容层 | 原生读取 Claude/Cursor 的 skills、rules、agents、MCP（.mcp.json）、hooks、sessions（`grok inspect` 可见） |
| 终端标题 | 人类可读会话名，不含 session id → 不走 OSC 捕获通道 |
| base URL | 无确认的环境变量；生效路径是 config.toml **per-model** `[model.xxx] base_url/env_key/api_backend` |

## 三个设计决策

### A. MCP 注入 = 写用户级 `~/.grok/config.toml`

- 否决项目级 `.grok/config.toml`：ccpanes MCP URL 带 orchestrator token，落进仓库有泄漏风险，且多会话并发互相覆盖。
- 否决 GROK_HOME 隔离：切断 auth.json（OAuth）与 sessions/（resume 历史）——Codex 隔离方案失败后的 `migrate_legacy_isolated_sessions` 善后是前车之鉴。
- 落地：`toml_edit` 保留式编辑 + `write_atomic` 原子写 + 首改 `.bak` 备份；幂等（值未变零写入）；`skip_mcp` 时移除 entry。
- **所有权签名**：只有 URL 匹配「loopback + `/mcp` + `token=` query」的 `ccpanes` entry 才视为 CC-Panes 所有、允许更新/移除；用户手工的同名 entry 保留不动。
- **降级点 1**：entry 为全部 grok 会话共享，URL 不带 `&launchId=`（附上会让最后一次启动冒充所有会话的 caller 身份），Orchestrator 暂无法自动识别 grok caller。
- **降级点 2**：MCP 隔离（`disable_unlisted_mcp_servers`）不支持——grok 没有 per-launch disable 通道，把 `enabled=false` 持久化进用户 config 会影响用户自己启动的会话，收到请求时 warn 降级。
- **降级点 3**：WSL grok 本期不注入 MCP（注入面在 WSL 内 `~/.grok/config.toml`，需 wslpath + UNC 写，参考 codex 的 `resolve_wsl_codex_config_windows_path`），TODO 后续增量。

### B. base_url = env 注入 `XAI_BASE_URL`（前瞻性）+ 不代写 per-model config

per-model 键需要猜 model 名/api_backend，写错会破坏用户模型配置。Provider 表单的 grok desc 明确说明自定义 base URL 需在 config.toml 按 model 配置。

### C. resume 走 `--session-id` 预发，改为能力驱动

- `CliToolCapabilities` 新增 `supports_issued_session_id`（`#[serde(default)]`，claude/grok = true）。
- `terminal_service.rs` 的发号 gate 从硬编码 `cli_tool == CliTool::Claude` 改为 `should_issue_session_id(registry, cli_tool, resume_id)`（查 adapter 能力）。
- 发号后 `terminal-resume-id-detected(source:"issued")` 事件通用，resume_binding → launch_history 链路零改动打通 grok。
- OSC 标题捕获（仅 codex）不变。

## 接入点清单

| 层 | 文件 | 改动 |
|----|------|------|
| adapter | `cc-cli-adapters/src/grok.rs` | 新建：build_command / MCP config 同步 / cc-pane 事件映射 |
| adapter | `cc-cli-adapters/src/lib.rs` | `supports_issued_session_id` 字段、注册、registry 测试 |
| core | `cc-panes-core/src/models/terminal.rs` | `CliTool::Grok` + `as_id()` |
| core | `cc-panes-core/src/models/provider.rs` | `ProviderType::Grok` → `XAI_API_KEY`/`XAI_BASE_URL` |
| core | `terminal_service.rs` | 发号 gate 能力化、WSL match 组、SSH 命令 |
| core | `terminal_service/wsl_codex.rs` | `build_wsl_supported_cli_command` 加 grok 分支 |
| tauri | `src-tauri/src/lib.rs` | 桌面端注册 GrokAdapter（web 端走 `with_builtin_adapters` 自动生效） |
| web | `types/terminal.ts` / `types/provider.ts` | `"grok"` 类型、META、兼容映射、`CLI_TOOL_TABS` |
| web | `sidebar/launchMenu.ts` | 启动菜单项 |
| web | `providers/ProviderFormPanel.tsx` | JSON 双向同步 + 默认类型 |
| web | `constants/providerPresets.ts` | xAI 官方预设 |
| web | i18n `{en,zh-CN}/{sidebar,settings}.json` | 文案 |

## capabilities 声明

```
provider ✓  resume ✓  mcp ✓  system_prompt ✓(--rules)  workspace ✗(无 --add-dir)
project_hooks ✗(原生 hooks 配置面未实机确认；但 map_cc_pane_event 已全量映射，
  事件名与 Claude 同构：SessionStart/SessionEnd/UserPromptSubmit/Pre|PostToolUse/Stop/Notification)
issued_session_id ✓  compatible_provider_types: ["grok"]
```

## 实机验证记录（2026-07-15，dev 实例）

- `launch_task(cliTool:"grok")` → 会话拉起成功，进程命令行
  `node ...\@xai-official\grok\bin\grok --session-id <uuid> "<prompt>"`（shim 改写、发号、位置 prompt 全部符合预期）。
- `~/.grok/config.toml` 正确注入 `[mcp_servers.ccpanes]`（url + enabled = true），原文件备份为 `.bak`。
- launch history 出现 `cliTool: "grok"` 记录；`resumeSessionId` 为 null——**对照 claude 走同一
  launch_task+daemon 路径同样为 null**，属 daemon 模式下 `terminal-resume-id-detected(issued)`
  事件未送达 app 绑定监听器的既有缺口，非 grok 特有（GUI 启动路径不受影响）。
- 验证中顺手修的缺口：`orchestrator_service.rs::parse_launch_cli_tool` 原本只放行
  claude/codex/opencode，已加 `"grok"`。
- **开发 gotcha**：`tauri dev` 不重建 `cc-panes-daemon`，`target/debug/binaries/cc-panes-daemon.exe`
  是历史构建的拷贝。改了 `CreateSessionRequest`/`CliTool` 等 daemon 反序列化的类型后，必须
  `cargo build -p cc-panes-daemon` 并把新 exe 拷入 `target/debug/binaries/`、杀掉旧 dev daemon
  （否则 daemon 返回 HTTP 422 unknown variant）。

## 后续 TODO

1. WSL grok MCP 注入（wslpath + UNC 写 WSL 内 config.toml）。
2. 实机确认 grok 原生 hooks 配置面（config.toml 段 or 独立文件）后开启 `supports_project_hooks`，HOOK_DEFS 照 claude.rs（剔除 before-compact/error）。注意 grok 的 claude harness 兼容层会读 `.claude/` 的 hooks——若直接复用 Claude 的项目 hooks 需评估双 CLI 同项目时的双触发问题。
3. 确认 `XAI_BASE_URL` 是否被 CLI 识别；若否且有需求，在 adapter 的同一支 config 写入逻辑里增量 per-model base_url。
4. BeforeCompact（PreCompact）/ Error（StopFailure）事件实机确认后补映射。
