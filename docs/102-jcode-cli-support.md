# 102 - Jcode CLI 接入

> 新增第 10 种 CLI 工具：[jcode](https://github.com/1jehuang/jcode)（Rust 编写的客户端-服务器
> 架构编码代理，主打极低内存占用与启动速度）。本期为 **v1 核心启动适配**：检测、启动、
> 托管 Provider（anthropic/proxy）、模型、effort、技能目录；会话历史、MCP 注入、hooks
> 映射、ACP/RPC 留作 v2 backlog。

## jcode 关键事实（实机核对 jcode v0.84.0，Windows）

| 项目 | 结论 |
|------|------|
| 安装 | Windows：`irm https://jcode.sh/install.ps1 \| iex` → `%LOCALAPPDATA%\jcode\bin`；macOS/Linux：`curl -fsSL https://jcode.sh/install \| bash`；macOS 另有 `brew tap 1jehuang/jcode` |
| 架构 | 客户端-服务器：TUI 只是客户端，会话由后台 daemon 持有（socket：Windows `%TEMP%\jcode-<user>\jcode.sock`，Linux `/run/user/$UID/jcode.sock`） |
| 启动 | `jcode` 直接进 TUI；`--version` 输出 `jcode v0.84.0 (hash)`，检测可用 |
| provider | `-p/--provider` 60+ 取值；`anthropic-api` = env 凭证直连通道；默认 `auto` 会优先用户已有的订阅 OAuth |
| model | `-m/--model <MODEL>` |
| resume | `--resume <ID\|名字>`；会话 ID 形如 `session_<动物>_<毫秒>_<hash>`；无 ID 时进交互式选择器（非 TTY 直接报错） |
| 初始 prompt | **TUI 不接受位置参数**（clap 报 unrecognized subcommand，实测）；headless 只有 `jcode run "msg"`（一次性退出，非 TUI） |
| YOLO | **不存在**（二进制中无 yolo/绕过权限概念，权限走内置 Safety System 的 TUI 交互） |
| 系统提示词 | 无 flag；jcode 的项目指令机制是 `AGENTS.md`（repo 根 + `~/AGENTS.md`） |
| MCP | 无注入 flag；原生**实时**读取 `~/.jcode/mcp.json`、项目 `.jcode/mcp.json`、Claude 兼容 `.mcp.json` / `~/.claude.json`（仅 stdio server，http/sse 识别后跳过） |
| skills | `~/.jcode/skills/<name>/SKILL.md`，与 Claude 同布局；jcode 会自动导入 Claude 生态技能（实机装完即出现整套 ccpanes-*） |
| hooks | env 钩子 `JCODE_HOOK_SESSION_START/END`、`JCODE_HOOK_TURN_START/END`、`JCODE_HOOK_PRE_TOOL/POST_TOOL`（v2 的状态跟踪/通知接入面） |
| 会话落盘 | `~/.jcode/sessions/`（另有 `sessions-index.json` 字符串证据）；**空会话不落盘**（日志："Retaining idle unsaved session"），本机暂无真实样本可解析 |
| provider env | `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL`、`OPENAI_API_KEY`、`JCODE_OPENAI_COMPAT_API_BASE`、`JCODE_API_KEY` / `JCODE_API_BASE`、`JCODE_HOME` |
| effort | env `JCODE_ANTHROPIC_REASONING_EFFORT` / `JCODE_OPENAI_REASONING_EFFORT`；档位 `none\|minimal\|low\|medium\|high\|xhigh\|max`，完整覆盖 cc-pane 六档 |
| 自动更新 | 默认开启，且 `auto_server_reload` 可能在会话中途热替换 daemon 二进制 |
| ACP | `jcode acp` 子命令（Agent Client Protocol 适配器）——远期可对接结构化 RPC 面 |

## 设计决策

### A. 默认注入 `--no-update`

面板启动要求确定性：自动更新检查 + `auto_server_reload` 可能在会话中途重载 daemon。
用户仍可在 TUI 内 `/update`，或用 extraArgs 追加 `--auto-update`（实测两 flag 同传不报
clap 冲突，运行时优先级以 jcode 内部实现为准）。

### B. 托管 Provider = 通用 env 注入 + 钉 `-p anthropic-api`

- `anthropic` / `proxy` 两个 Provider 类型的通用 `to_env_vars()` 恰好产出
  `ANTHROPIC_API_KEY`（+ 可选 `ANTHROPIC_BASE_URL`），jcode 原生读取 → **适配器不重复
  注入 env**（有测试断言），密钥永不进命令行。
- 适配器只负责钉 `--provider anthropic-api`：防止 auto-detect 偏向用户自己的 Claude
  订阅 OAuth，保证托管凭证生效。
- `managed_provider_conflict_env_keys(Jcode)` 清 11 个继承键：`ANTHROPIC_API_KEY` /
  `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_OAUTH_TOKEN` / `ANTHROPIC_BASE_URL`、
  `OPENAI_API_KEY`、`JCODE_API_KEY` / `JCODE_API_BASE` / `JCODE_ANTHROPIC_API_BASE` /
  `JCODE_ANTHROPIC_AUTH` / `JCODE_PROVIDER` / `JCODE_MODEL`。
- `open_ai` / `gemini` 等类型**不在** `compatible_provider_types`：通用映射产出的是
  `CODEX_API_KEY` / `GEMINI_API_KEY`，不在 jcode 读取面内，放行只会静默失效。
- 不做 `JCODE_HOME` 状态隔离：会连带切断用户的 config.toml/keymap/skills；凭证冲突已由
  冲突 env 表 + 显式 `-p` 双保险覆盖。

### C. resume flag 已接线，能力位保持 false

jcode 的 `--resume` 工作正常，但 cc-pane 的 resume id 来源是会话索引，而 jcode 的
session index parser 尚未存在（落盘格式无真实样本，见上表）。先接线 flag（含 WSL
分支），`supports_resume=false` 保持 UI 诚实；v2 接入 `~/.jcode/sessions/` 解析后翻转。

### D. effort 走 env 而非 flag

jcode 无 effort CLI flag，`JCODE_ANTHROPIC_REASONING_EFFORT` /
`JCODE_OPENAI_REASONING_EFFORT` 同时注入（jcode 按当前 provider 家族取用），六档取值
与 jcode 档位一一同名，直接透传。WSL 分支以 remote 端 `export` 注入（同 Claude 的
`MAX_THINKING_TOKENS` 模式）。

### E. 显式忽略的启动输入

`initial_prompt` / `append_system_prompt` / `yolo_mode` 均无对应 jcode 启动面，静默忽略
（好过把 prompt 当位置参数导致 clap 报错、面板启动即崩）。前端同步：YOLO chip
隐藏、SSH 环境不可选（v1 未实机验证 SSH 链路）。~~MCP 卡片显示「不支持」~~
（docs/104 已接入：MCP 卡片解禁、skipMcp chip 恢复显示）。

### F. v1 未接（backlog）

| 项 | 阻塞点 |
|----|--------|
| 会话历史 / resume UI | `~/.jcode/sessions/` 落盘格式需真实样本（空会话不落盘） |
| 用量 / 上下文统计 | 同上，依赖 transcript 解析 |
| ~~MCP 注入~~ | **已落地（docs/104）**：收据驱动写项目 `.jcode/mcp.json`，仅 stdio（http/sse 层条目跳过），共享 MCP 用原始 stdio 定义，ccpanes 内置走 ctl mcp-proxy |
| 项目 hooks / 通知 | `JCODE_HOOK_*` env 钩子面已确认存在，未做事件映射 |
| 编排启动 / 结构化结果 | `jcode run --json` 是候选通道，未实机验证 |
| RPC | Pi 风格 JSONL RPC 不接；**ACP 已接**（见下） |
| SSH 启动 | 后端穷举表已兜底（`jcode --no-update`），前端 v1 不放开；jcode 自有 `--ssh` 客户端-服务器模式是另一套语义，需单独设计 |

### ACP 引擎（「对 agent 说」调度器）

jcode 自带原生 ACP 适配器子命令 `jcode acp`（stdio，由 jcode daemon 支撑），
已登记进 `src-tauri/src/commands/acp_chat_commands.rs` 的 `ACP_ENGINES`：
`{ id: "jcode", executable: "jcode", args: ["acp"] }`。首页「对 agent 说」与
Agent Chat 的引擎下拉由该表数据驱动，登记即出现（可执行文件解析成功即 available）。
注意这与终端面板适配器是**两条独立链路**：ACP 引擎服务对话式调度（带首条 prompt），
终端适配器服务 TUI 面板启动（jcode TUI 不接受位置参数 prompt，故首页 prompt 不走
终端链路）。

## 接入点清单（本次实际改动）

### cc-cli-adapters

| 文件 | 改动 |
|------|------|
| `src/jcode.rs` | **新建**：info/capabilities/build_command + `global_skills_dir`（`~/.jcode/skills`，NativeSkill 投递）+ 10 条单测 |
| `src/lib.rs` | `mod jcode` + `pub use JcodeAdapter`；registry 注册（omp 之后）；守卫测试 id 清单 + `jcode`；`windows_user_cli_dirs` 补 `%LOCALAPPDATA%\jcode\bin`（PATH 更新对已运行桌面 app 不可见） |

### cc-panes-core

| 文件 | 改动 |
|------|------|
| `src/models/terminal.rs` | `define_cli_tools!` 加 `Jcode => "jcode"` |
| `src/services/provider_resolver.rs` | `managed_provider_conflict_env_keys` 加 Jcode arm（11 键，见决策 B） |
| `src/services/terminal_service.rs` | `ssh_remote_cli_command` 加兜底行；WSL 分发 match 组加 `CliTool::Jcode` |
| `src/services/terminal_service/wsl_codex.rs` | WSL 可执行名表加 `jcode`；effort remote export 块；参数方言分支（`--no-update` / `-p anthropic-api` / `--resume` / extraArgs，无位置参数 prompt） |

`src-tauri` 无必改：registry 走 `with_builtin_adapters()` 自动生效，`list_cli_tools`
数据驱动，编排启动白名单已能力驱动。

### web

| 文件 | 改动 |
|------|------|
| `types/terminal.ts` | `KNOWN_CLI_TOOLS` + `jcode`（穷举守卫源头） |
| `types/provider.ts` | `CLI_TOOL_TABS` + jcode（tabJcode，accent `#0891B2`） |
| `components/CliToolSelect.tsx` | `CLI_COLOR_VAR` + jcode |
| `components/sidebar/launchMenu.ts` | 菜单项 + `supportsSsh: false` |
| `assets/index.css` | `--app-cli-jcode` 亮 `#0891B2` / 暗 `#06B6D4`（品牌为黑白灰，灰系已被 grok/cursor 占用，取未占用青色相；暗色比 identity-ssh 的 `#67E8F9` 压暗一档避免混淆） |
| `components/providers/launchProfileHelpers.ts` | `TOOL_LABELS` + jcode |
| `utils/providerCompatibility.ts` | fallback 表 + `jcode: ["anthropic", "proxy"]` |
| `components/panes/terminalCliInstallHint.ts` | 双平台安装命令提示 |
| `components/launcher/launcherModel.ts` | draft patch（yolo 清空）；`jcode_ssh_unsupported` issue；SSH 守卫 |
| `components/launcher/LauncherEnvRow.tsx` | SSH 环境选项过滤 |
| `components/launcher/LauncherChips.tsx` | YOLO/skipMcp chips 隐藏（变量更名 `hideYoloMcpChips`） |
| `components/launcher/LauncherDialog.tsx` | issue → toast 映射；args preview yolo 清空 |
| `components/providers/LaunchProfileMcpCard.tsx` | MCP 卡片显示「不支持」 |
| `components/providers/LaunchProfileBasicsCard.tsx` | runtime 仅 local/wsl；yolo 开关隐藏（`localWslOnlyTool`；Provider 文案不跟 Pi 家族特化） |
| `components/providers/LaunchProfilesPanel.tsx` | SSH profile 保存拒绝 toast；yoloMode 强制 false |
| `components/providers/ProviderFormPanel.tsx` | jcode tab 默认 ProviderType = anthropic |
| i18n（en + zh-CN） | `sidebar.cliToolJcode`、`settings.tabJcode`、`launcher.errorJcodeSshUnsupported`、`providers.jcodeSshRuntimeUnsupported` |
| 测试 | `launchMenu.test.ts` 清单 + `LOCAL_WSL_ONLY_TOOLS`；`cliToolCoverage` / `providerCompatibility` / `terminalCliInstallHint` 守卫自动生效 |

`web/stores` 无需改动（默认 CLI 下拉由 `list_cli_tools` 数据驱动）。

### docs

- 本文档；`README.md` 徽章 + `Jcode`（并移除已删除适配器遗留的 GLM 徽章），
  `docs/readme/README.*.md` 六语言同步。

## 验证记录

- `cargo test -p cc-cli-adapters`：204 passed（含 10 条 jcode 新测试 + 注册表守卫更新）
- `cargo check --workspace` / `cargo test --workspace`：全绿（`cc-panes-web` 的
  comfy 媒体测试在全量高负载下偶发超时，隔离重跑通过——既有负载抖动，非回归）
- `cargo clippy --workspace --all-targets -- -D warnings`：仅两处**既有**误报
  （`skill_link_service.rs` / `performance_recorder/models.rs` 的
  field_reassign_with_default，clippy 1.97 本地已知问题，均非本次改动文件）
- `npx tsc --noEmit` 零错误；`npm run test:run` 5350/5350 全绿
  （含行数棘轮：StatusBar 500/500、LaunchProfilesPanel 577/577 贴线通过）
- `cargo fmt --all -- --check` 通过
- 实机（Windows，jcode v0.84.0）：`--version` 检测、`--help` 全量 flag 核对、
  TUI 位置参数 prompt 拒绝、`--no-update --auto-update` 同传解析、effort 档位字符串、
  `JCODE_*` env 面（二进制字符串提取）均已验证
- 壁纸兼容预检（docs/54 §3，静态部分）：jcode 使用 alt-screen（二进制含
  `\x1b[?1049h/l`），自绘全屏 TUI，与 claude/codex 同类，走标准处理路径
- **实机端到端（dev 构建）**：侧栏启动菜单出现 Jcode 项；「用 jcode 打开」启动后
  面板运行 jcode TUI v0.84.0（`jcode.exe --no-update`，自动拉起 serve daemon），
  工作目录正确、`skills: 15 loaded`（ccpanes-* 技能集被 jcode 读取）、用户自有
  provider（openai(key)）可用；背景渲染干净无壁纸残影

### 开发迭代坑：侧车不同步 = 幽灵 bug

首跑实机验证时「用 jcode 打开」实际启动了 **Claude**：标签/状态栏都显示 Jcode，
PTY 里却是 Claude Code TUI。根因链：终端 spawn 由**常驻侧车 `cc-panes-daemon`**
执行，dev 流程（`npm run tauri:dev`）只重建 app 本体，`debug/binaries/` 里的
daemon 仍是当天 13:24 的旧构建；旧 daemon 的 `CliTool::from_id("jcode")` 返回
None，`effective_cli_tool()` 在 `launch_claude=true` 时回落 Claude——**未知 CLI id
被静默换成 Claude**，无任何报错。

修复：重建 daemon 并同步 `src-tauri/binaries/` 与 `debug/binaries/` 两处，杀常驻
daemon 让 app 重拉。后续按 AGENTS.md「Sidecar sync after backend changes」流程
对 daemon/cli-hook/ctl/web 四个侧车做了全量同步。教训：**改了 cc-panes-core 或
适配器后必须同步侧车再验证**，否则测的是旧二进制。
