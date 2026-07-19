# Windows `\\?\` UNC 路径污染：CLI hook 回填 → 历史回流 → PTY cwd 崩

> 状态：待实施 | 优先级：**高**（正在持续污染数据）| 基线：工作树内有十个 worker 的未提交改动，**不要动它们**

## ⚠️ 并发警告

**另有 worker 正在改**：`web/components/TitleBar.tsx`、`web/components/home/`、
`web/components/ActivityBar.tsx`、`web/components/sidebar/ExplorerView.tsx`、
i18n 的 `common.json` / `sidebar.json` / `home.json`。**这些一律不要碰。**

**禁止任何 git 写操作**（工作树里有十个 worker 的未提交成果）。
测试若见上述目录相关失败，与本任务无关，忽略并注明。

## 现象

从「默认工作空间」（**及其它工作空间**）启动 Claude Code 时：

```
'\\?\C:\Users\wuxiran\.cc-panes-dev\workspaces\default'
CMD.EXE was started with the above path as the current directory.
UNC paths are not supported.  Defaulting to Windows directory.
```

cmd.exe 拒绝该 cwd，CLI 启动在 `C:\Windows`——工作目录完全错误。

**首次**从侧栏启动是正常的；**第二次**（走「最近启动」或恢复）才中招。

## 根因链（已实证，非推测）

1. **注入点** `cc-panes-cli-hook/src/session_start.rs:141`
   ```rust
   let project_dir = project_dir.canonicalize().unwrap_or(project_dir);
   ```
   Windows 上 `canonicalize()` 必然产出 `\\?\` 前缀。该值经
   `session_start.rs:184` → `send_session_started`（`:320-346`）
   作为 `cwd` 上报 `/api/terminal/session-started`。

2. **落库覆盖** `src-tauri/src/services/orchestrator_service.rs:7044-7052`
   （`handle_session_started`）→ `cc-panes-core/src/repository/history_repo.rs:342`
   ```sql
   launch_cwd = COALESCE(?6, launch_cwd)
   ```
   **覆盖**掉前端写入的干净值。`upsert_session_started`（`:404`）同样。

3. **回流** `web/utils/launchHistory.ts:46`
   ```ts
   workspacePath: optionalValue(record.launchCwd ?? record.workspacePath),
   ```
   `launchCwd` **优先于** `workspacePath`。从「最近启动」
   （`RecentLaunches.tsx` / `SessionsView.tsx:128`）或启动器
   `source.kind === "recent"`（`launcherModel.ts:150-153`）再启动时，
   UNC 路径成为 `OpenTerminalOptions.workspacePath`。

4. **进 PTY** `useOpenTerminal.ts:49,55` → `create_terminal_session` →
   `cc-panes-core/src/services/terminal_service.rs:1796-1799`
   → `cc-panes-core/src/pty/mod.rs:151` `cmd.cwd(&config.cwd)` → 崩。

**全链路无任何规范化**：`path_validator.rs:12` 只查 `..` 与绝对性；
`launch_request.rs:3` 的 `normalize_session_request_for_current_host` 只在宿主是 WSL 时生效。

**已排除**：`app_paths.rs:22`（只是 `dirs::home_dir().join(...)`）、
`workspace_service.rs:157/239`、提交 `9f319cd`。`workspace.json` 里的 path 是干净的。

## 影响范围（实测 dev 库）

- **41 条** `launch_history.launch_cwd` 带 `\\?\`，跨 9 个工作空间
  （nanan / erp-workspace / vms / emergency / cc-book / android-workspace /
  2api / emergency-crawler / default），几乎全是 `cli_tool=claude, runtime=local`
- 目前 **3 条** `workspace_path` 已被回流污染，**每从「最近启动」重启一次就多一条**
- **不限于默认工作空间**

## 改动

按层次做，**每层都要**——单点修复不足以止血（存量数据已污染）。

### 1. 共享工具（先做，后续各层复用）

仓库现有 `strip_unc_prefix`（`orchestrator_service.rs:7982`）是**私有 fn、
只在 src-tauri、只被 3 个编辑器开文件的调用点用**（`:4136`、`:4161`、`:4224`），
启动链路完全没走它。

**提升到 `cc-panes-core/src/utils/`** 供各层共用；
或给相关 crate 加 `dunce` 直接依赖，统一改用 `dunce::simplified` / `dunce::canonicalize`。
`dunce` 目前只作为 tauri/wry 的**传递依赖**存在于 `Cargo.lock`，
**没有任何 Cargo.toml 直接依赖**——若选这条路需显式添加。

**二选一，不要两套并存。** 在汇报里说明你选了哪条及理由。

### 2. 根因

`cc-panes-cli-hook/src/session_start.rs:141` —— canonicalize 后剥前缀
（或换 `dunce::canonicalize`）。

### 3. 入库防线

`cc-panes-core/src/repository/history_repo.rs:342` 与 `:404` ——
写 `launch_cwd` 前统一规范化。即使上游漏网也不落脏数据。

### 4. 回流防线

`web/utils/launchHistory.ts:46` —— 前端兜底剥 `\\?\`。

**顺带质疑这个优先级本身**：`launchCwd ?? workspacePath` 让 hook 回填的值
盖过前端明确写入的工作空间路径，是否合理？
**不要擅自改优先级**（可能有依赖它的场景），在汇报里给出你的判断。

### 5. 兜底闸门

`terminal_service.rs:1796-1799`（及 WSL 分支 `:1600`）或 `pty/mod.rs:151` ——
spawn 前对 cwd 做一次去 UNC。这是最后一道，任何上游漏网都拦住。

### 6. 存量数据迁移

`data.db` 的 `launch_history` 表：把已污染的 `launch_cwd` / `workspace_path`
洗掉（剥前缀）。**否则修了代码旧记录照样炸。**

放在既有的 DB 迁移机制里（参考 `cc-panes-core/src/repository/db.rs` 的建表/迁移写法），
要幂等、可重复执行。**注意这会修改用户真实数据——迁移逻辑必须只剥 `\\?\` 前缀，
不做任何其它改写。**

## 同源隐患（本次不做，仅在汇报里确认）

1. `cc-panes-core/src/services/filesystem_service.rs:30-34` `validate_path`
   返回 canonicalize 后的路径，`list_directory`（`:325`）/ `entry_from_path`（`:269`）
   把 `\\?\` 前缀的 path 吐给前端文件树。
   **将来做「文件树右键启动终端」会立刻复现同样的崩法。**
2. `cc-panes-daemon/src/main.rs:216` 与 `cc-panes-web/src/main.rs:212`
   都 canonicalize 了 `default_cwd`；请求缺 `project_path` 时回落到该 UNC 值
   （`daemon/src/server.rs:431`、`cc-panes-web/src/routes/terminal.rs:139`）。
   dev 实例 `daemonEnabled = true`，**这条路是活的**。

这两条要不要一并修由 leader 决定——**先在汇报里给出评估，不要擅自扩大范围**。

## 验收

- `cargo check --workspace`、`cargo clippy --workspace -- -D warnings`、`cargo test --workspace`
- `npx tsc --noEmit`
- `npx vitest run web/utils/ --maxWorkers=2`
- 补测试：
  - hook 侧：canonicalize 后的路径不含 `\\?\`
  - repo 侧：写入带 UNC 的 `launch_cwd` 后读出是干净的
  - 前端：`launchHistory` 解析带 UNC 的记录后 `workspacePath` 干净
  - 迁移：对含 UNC 的历史行执行迁移后变干净，且重复执行幂等
- **非 Windows 平台上这些函数必须是 no-op**，不得影响 Linux/macOS 路径
