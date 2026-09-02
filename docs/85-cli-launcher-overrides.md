# 85 — CLI 路径解析与 launcher override（macOS "not found" 排障手册）

> 状态：随 0.12.1 落地。背景：macOS GUI 应用从 Dock/Finder 启动**不继承 shell 的 PATH**（只有 `/usr/bin:/bin:/usr/sbin:/sbin`），而 claude/codex 通常装在 nvm/homebrew/bun 等 shell 配置才进 PATH 的目录。本文记录解析链全貌与用户侧逃生阀。

## 解析优先级链（从高到低）

| 层 | 位置 | 说明 |
|---|---|---|
| 1. 用户 override | `config.toml` `[cliLaunchers.overrides.<toolId>]` | 绝对路径/含分隔符 → **原样直通**，不做任何改写；裸命令名 → 再过一遍 resolve |
| 2. `which`（进程 PATH） | `cc-cli-adapters/src/lib.rs::resolve_executable` | 进程 PATH 已被启动期两层修正（见下） |
| 3. 常见目录扫描 | 同上 `candidate_executable_dirs` | PATH 拆分 + `cached_path` 缓存文件 + nvm 全版本（semver 降序）+ cargo/local/homebrew/macports + **bun/pnpm/volta/asdf/fnm**（0.12.1 补） |
| 4. login-shell 同步兜底 | 同上 `login_shell_path_dirs`（0.12.1 新增） | 白名单全落空时同步跑一次 `$SHELL -ilc "echo $PATH"`（8s 超时、进程级缓存、失败也缓存），covers 首启无缓存窗口期 |

启动期 PATH 修正（`src-tauri/src/lib.rs::load_full_path`，仅非 Windows）：

1. 读 `~/.cc-panes[-dev]/cached_path` 缓存 → 立即生效，后台 login shell 刷新；
2. 无缓存 → `build_fallback_path()` 纯 fs 扫描白名单（<1ms）→ 后台刷新。
   `$SHELL` 缺失时回落 `/bin/zsh`（macOS）/`/bin/sh`（其他），见 `resolve_login_shell`。

daemon 侧：`start_daemon_process` spawn 时显式注入「cached_path ∪ 当前进程 PATH」（daemon 自身无 PATH 修正逻辑，0.12.1 补）。

## Override 的三条配置通道

1. **设置面板** → CLI Launchers section（搜索 "launcher" 可直达）；
2. **MCP 工具**：`set_cli_launcher_override` / `clear_cli_launcher_override` / `list_cli_launcher_overrides`（仅对新建 local 会话生效，不影响 WSL/SSH）；
3. **手改** `~/.cc-panes/config.toml`：

```toml
[cliLaunchers.overrides.claude]
command = "/Users/me/.nvm/versions/node/v22.14.0/bin/claude"
```

校验：禁换行、≤1024 字符、拒 `;` `|` 反引号 `$(`（`path_validator::validate_command`）。

### Cursor Agent（`cliTool: "cursor"`）

`launch_task` / `dispatch_task` 已支持 `cliTool: "cursor"`（与 claude/codex 同级编排）。

| 项 | 说明 |
|---|---|
| 默认可执行 | 解析顺序：**override → `cursor-agent` → `agent`**；Windows 会扫 `%LOCALAPPDATA%\cursor-agent\`（`.cmd` 经 `cmd.exe /c` 进 PTY） |
| override 示例 | `[cliLaunchers.overrides.cursor]` → `command = "C:\\Users\\…\\AppData\\Local\\cursor-agent\\cursor-agent.cmd"` |
| 自动 flag | 编排启动始终带 `--trust`（跳过 Workspace Trust）与 `--approve-mcps` |
| YOLO | 全局/会话 YOLO 开时映射为 `--force`（= `--yolo`，Run Everything，跳过 shell 审批） |
| 模型 | `modelId` → `--model <id>`（如 `claude-fable-5-high`） |
| 首 prompt | 位置参数注入；resume 用 `--resume <chatId>` |
| MCP | 启动时 upsert `~/.cursor/mcp.json` → `mcpServers.ccpanes.url`（loopback + token；可带 launchId）。多并发会话共享 entry，**最后一次启动覆盖**。`skip_mcp` 会移除托管 entry |
| print worker | `adapterOptions.print` 或 `headless` = true → `-p --output-format text` |
| WSL | launch flags 已对齐；`list_resume_sessions(runtimeKind=wsl)` 扫发行版内 `~/.cursor/chats` |

手测：`dispatch_task(projectPath=…, cliTool="cursor", prompt="只回复 cursor-cli-ok，不改文件")` 应开新 pane 且不再报 `not supported by launch_task yet`。

Resume：
- `list_resume_sessions(cliTool="cursor", projectPath=…)` 扫 chats meta
- 新 launch 后台 `cursor-chat-scan` 自动把 chat uuid 写入 `launch_history.resume_session_id`

### 能力矩阵（相对 Claude/Codex）

| 能力 | 状态 | 说明 |
|------|------|------|
| launch/dispatch local | ✅ | |
| `--trust` / YOLO `--force` / `--model` | ✅ | |
| waitingInput / thinking / toolRunning | ✅ 弱 | PTY 短语启发式，非 OSC/hook |
| `list_resume_sessions` local + WSL | ✅ | |
| resume id → launch_history | ✅ | `cursor-chat-scan`（mtime/cwd 匹配，并发可能串） |
| ccpanes MCP / report_to_leader | ✅ 弱 | 用户级 mcp.json；无 per-launch 隔离 |
| print 无交互 worker | ✅ | `adapterOptions.print`；`cursor_bridge action=context` 必开 |
| `--mode ask` 只读 | ✅ | `adapterOptions.readOnly`（Cursor Bridge `context` / `readOnly`） |
| Cursor Bridge 持续会话 | ✅ | `cursor_bridge sessionMode=create/continue`；登记簿在 `{app_config_dir}/cursor-bridge/` |
| issued session id / OSC 标题 | ❌ | Cursor CLI 无对等通道 |

## macOS "claude CLI not found" 排查顺序

1. `cat ~/.cc-panes/cached_path`——看缓存的 PATH 里有没有装 CLI 的目录；没有该文件说明 app 从未成功抓过 shell PATH。
2. 删掉 `cached_path` 后重启 app——强制重抓（后台 `$SHELL -ilc`，10s 超时）。
3. 终端里 `which claude` 拿到绝对路径，填进 CLI Launchers override——**终极逃生阀**，绕开全部解析。
4. 还不行：确认 `echo $SHELL` 非空、CLI 真的可在交互终端运行。

## 历史坑（已修，0.12.1）

- **nvm 版本目录曾按字典序挑"最新"**：`v9.x > v20.x`（'9' > '2'），claude 装在 v20 时挑到 v9 的 bin。两处（adapter 扫描 + fallback PATH）已统一为 `compare_version_dir_names` semver 感知比较。
- bun/pnpm/volta/asdf/fnm 曾不在任何扫描名单。
- `$SHELL` 缺失时曾回落 `/bin/sh`，`-ilc` 不读 zsh 配置，刷新白跑。
