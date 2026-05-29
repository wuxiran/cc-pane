# Feature 17 — Provider 软热切换（运行中 Pane 切供应商）

| 项 | 值 |
|---|---|
| 状态 | 需求待开发 |
| 类型 | Feature spec |
| 来源 | 2026-05-28 plan mode 评审定稿（Claude 主写 + WSL Codex `gpt-5.5 xhigh` 同行评审吸收 9 条必修 + 4 条开放问题决议） |
| 评审通道 | CC-Panes plan2codexwsl（leader=Claude / worker=Codex WSL，PTY 自动 `report_to_leader` 反馈） |
| 相关历史 | [provider-design-decision.md](./provider-design-decision.md)、[issue-provider-passing-inconsistency.md](./issue-provider-passing-inconsistency.md) |
| 原始 plan | `~\.claude\plans\provider-api-quizzical-engelbart.md`（同等内容） |

> 本文档是需求 spec，作为后续 task 拆分的 master spec。实施前请阅读"已评审决议"段，明白哪些是经过同行评审的硬约束、不可被"优化"。

---

# Provider 软热切换（右键 Pane 切供应商，覆盖 Local / WSL / SSH）

## 已评审决议（WSL Codex 同行评审吸收）

- **回滚策略 + 状态同步**：选 A 原子双 PTY 替换 + `switch_session_provider` 同步 `TaskBinding / LaunchHistory / SavedSession`。kill 后失败再重连的方案被否决。
- **UI 入口 + Codex CODEX_HOME**：选 A，Provider 菜单挂在 Pane chrome/notch（与 Tab 标题/close 同条带），右键不侵入 xterm；Codex 的 isolated CODEX_HOME 按 `resume_id` 稳定建目录，切 provider 时复用同一目录避免 resume 历史查不到。
- **依赖注入 + 安全范围**：Tauri command 层同时注入 `TerminalService` 和 `TaskBindingService`，`TerminalService` 不持有 binding 依赖；默认只允许同 **trust level** 切换（"官方 Anthropic ↔ 官方 Anthropic"、"第三方代理 ↔ 第三方代理"），跨 trust 必须用户在 Provider 设置里显式打开"允许跨信任级切换"开关 + 切换时强二次确认。
- **强制采纳的修复**（reviewer 明确指出，无替代方案）：
  - 加 `KillReason::ProviderSwitch`，软重启时不触发 `session-killed` → `closeTabBySessionId`
  - 加 session 级 switch lock + 前端 leaf id + oldSessionId 双条件迁移
  - SSH 路径补 `--resume`，否则切 provider 后 SSH 对话不延续
  - 跨 base_url 强制二次确认（独立于 trust level 限制）

## Context

用户希望运行中的 Tab/Pane 能切换 Provider（例如换个 API 供应商）。调研结论：

- Claude/Codex CLI 都**不支持运行时改 Provider**，没有 `/provider` slash 命令，也没有 `--provider` 标志；Provider 完全靠环境变量在 PTY spawn 时一次性注入（`cc-panes-core\src\models\provider.rs:48-140` 的 `to_env_vars()`）。
- **OS 层面也无法修改正在运行进程的 env**：portable-pty 用 `CommandBuilder` spawn 后没有 mutation API；Unix env 是 COW；Windows ConPTY 完全隔离。
- 唯一可行的"软热切换"路径：**原子双 PTY 替换** —— 先用新 Provider env 在后台 spawn 新 PTY，成功后原子替换 sessions map，再 kill 旧 PTY，传 `--resume <id>` 让 CLI 恢复对话。失败旧 PTY 不动。

三种 runtime 的 provider 注入路径：

| Runtime | 注入方式 | 代码位置 |
|---|---|---|
| Local | `env_vars.extend(provider_vars)` 后传给 `spawn_pty` | `terminal_service.rs:1248` |
| WSL（Claude / 非纯 Codex） | 同 Local，env_vars 进 PtyConfig；WSLENV 透传 | `terminal_service.rs:1248, :1347-1379` |
| WSL Codex（纯 WSL） | `pure_wsl_codex_launch=true` 跳过主机 env，通过 `push_wsl_env_exports` 在远程 bash 启动脚本里 `export KEY=value` | `terminal_service\wsl_codex.rs:89-103` |
| SSH | `build_ssh_command(ssh_info, cli_tool, &provider_vars, ...)` 拼进远程命令；**目前明确跳过 `--resume`，需补** | `terminal_service.rs:1387, :2533` |

预期结果：用户在 local Claude / WSL Codex / SSH Claude 任一面板上 → Pane 顶部条带点 Provider 标识 → 选另一个同 trust level 的兼容 Provider → 后端先 spawn 新 PTY 验证成功，再原子替换 + kill 旧进程 → 前端 sessionId 平滑替换，对话延续，Tab 不闪关。

## 设计

### 关键约束

- **新 sessionId 必须先 spawn 成功再用**：原子双 PTY 替换的核心；spawn 失败旧 PTY 不动，对用户无感。
- **resume_id 复用 + Codex CODEX_HOME 按 resume_id 稳定**：Claude Code 把会话存本地 `~/.claude/projects/`；Codex isolated CODEX_HOME 默认按 sessionId 建目录会让换 sessionId 后查不到 resume 历史，必须改为按 resume_id 建目录（无 resume_id 时退回 sessionId）。
- **trust level 二元分类**：`trust_level: "official" | "third_party"`，加到 `Provider` 模型上。Anthropic / Bedrock / Vertex / OpenAI 直连官方 = official；ConfigProfile / Proxy / 其他第三方兼容 = third_party。默认只允许同 trust level 切换。
- **switch lock**：后端按 `session_id` 维度的 Mutex，禁止并发切换。
- **TerminalService 不持有 TaskBindingService**：依赖注入在 Tauri command 层完成。
- **KillReason 枚举**：`Normal | ProviderSwitch`；`ProviderSwitch` 不 emit `session-killed`。

### 后端改动（Rust）

**1. `cc-panes-core\src\models\provider.rs`** — 加 `trust_level`

```rust
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderTrustLevel { Official, ThirdParty }
```
`Provider` 加 `pub trust_level: ProviderTrustLevel`。每个 `ProviderType` 提供默认值（`Anthropic/Bedrock/Vertex/OpenAI/Gemini` = Official；`Proxy/ConfigProfile/Kimi/Glm/Cursor/OpenCode` = ThirdParty）。允许用户在 UI 上覆盖（极少需要）。

**2. `cc-panes-core\src\services\terminal_service.rs` — `TerminalSession` 补字段**

补的字段（克隆出来给软重启用）：
```
cli_tool, project_path, workspace_name, workspace_path, workspace_snapshot_id,
launch_profile_id, provider_id, provider_selection, resume_id, cwd, cols, rows,
ssh, wsl, launch_id, append_system_prompt
```
在 `create_session` 末尾组装 `TerminalSession` 时填入。

**3. `cc-panes-core\src\services\terminal_service.rs` — `KillReason` 枚举 + `kill` 重构**

```rust
pub enum KillReason { Normal, ProviderSwitch }
pub fn kill_with_reason(&self, session_id: &str, reason: KillReason) -> AppResult<()>
```
`Normal` 走现有路径（emit `session-killed`）；`ProviderSwitch` 不发关闭事件，仅 stop PTY + 转 dead_buffers。原 `kill(session_id)` 改为 `kill_with_reason(.., Normal)` 调用。

**4. `cc-panes-core\src\services\terminal_service.rs` — 新增 switch 主体**

```rust
pub async fn switch_session_provider(
    &self,
    session_id: &str,
    new_provider_id: Option<&str>,
    provider_selection: LaunchProviderSelection,
    allow_cross_trust: bool,
) -> AppResult<SwitchProviderOutcome>
```

逻辑（**原子双 PTY 替换** + **switch lock**）：

```text
1. 取 switch lock：self.switch_locks.lock(session_id)；已锁返回 Conflict
2. 读快照：克隆出旧 session 的所有元数据，含 cli_tool / resume_id / wsl / ssh ...
3. 兼容性校验：
   - new_provider 的 ProviderType 在 cli_tool 兼容集 → 否则 InvalidArgument
   - trust_level 校验：new.trust_level != old.trust_level 且 allow_cross_trust=false → InvalidArgument
4. 后台 spawn 新 PTY：内部走 create_session_inner（带 resume_id、wsl、ssh、新 provider_id）
   - 关键：先不替换 sessions map，先确认 spawn_pty 成功且 PTY 进程存活
   - 失败 → 释放 lock，返回 SpawnFailed，旧 session 完整保留
5. 原子替换：sessions.remove(old) → sessions.insert(new)；旧 process Arc 用 kill_with_reason(.., ProviderSwitch)
6. emit Tauri 事件 terminal://session-replaced { oldSessionId, newSessionId, providerId, resumeId, cliTool, trustLevel }
7. 释放 lock
8. 返回 SwitchProviderOutcome { new_session_id, resume_id, provider_id }
```

`switch_locks` 加在 `TerminalService` 上：`Arc<Mutex<HashSet<String>>>`（session_id 进集合 = 锁中）。

**5. Codex isolated CODEX_HOME 按 resume_id 稳定**

`cc-cli-adapters\src\codex.rs::prepare_isolated_codex_home` 当前按 sessionId 建目录。改为：
- 有 `resume_id` → 目录名用 `cdx-{resume_id_hash}`
- 无 `resume_id` → 退回 `cdx-{session_id}`

WSL Codex 路径 `terminal_service\wsl_codex.rs` 同步逻辑。这样 switch 时新 sessionId 但同 resume_id 会指到同一 CODEX_HOME。

**6. SSH 路径补 `--resume`**

`terminal_service.rs:1383` 注释和 `build_ssh_command` 实现：把 `ctx.resume_id` 传进远程命令拼接（Claude `--resume <id>`、Codex 对应参数）。注意 SSH 命令转义。

**7. `src-tauri\src\commands\terminal_commands.rs`** — 新 Tauri command（**双 State 注入**）

```rust
#[tauri::command]
pub async fn switch_session_provider(
    terminal: State<'_, Arc<TerminalService>>,
    task_binding: State<'_, Arc<TaskBindingService>>,
    session_id: String,
    new_provider_id: Option<String>,
    provider_selection: LaunchProviderSelection,
    allow_cross_trust: bool,
) -> AppResult<SwitchProviderOutcome> {
    let outcome = terminal.switch_session_provider(...).await?;
    // 同步 TaskBinding：在 command 层做，TerminalService 不依赖 binding
    if let Some(binding) = task_binding.find_by_session(&session_id)? {
        task_binding.update_session_id(&binding.id, &outcome.new_session_id)?;
    }
    Ok(outcome)
}
```
注册到 `src-tauri\src\lib.rs` 的 `invoke_handler`。

**8. LaunchHistory 同步**

`launch_history_service::add_launch_history` 在 command 层补一条 "provider switch" 记录，sourceSessionId/targetSessionId/providerId 都写入。或者复用 `find_by_pty_session_id` 路径更新已有 entry —— 看 `launch_history_service.rs` 现有写法选最小改动方案。

### 前端改动（TypeScript / React）

**1. `web\services\terminalService.ts`** — 加封装

```ts
switchSessionProvider(args: {
  sessionId: string;
  newProviderId: string | null;
  providerSelection: LaunchProviderSelection;
  allowCrossTrust: boolean;
}): Promise<{ newSessionId: string; resumeId: string | null; providerId: string | null; cliTool: CliTool; trustLevel: ProviderTrustLevel }>
```

**2. `web\stores\usePanesStore.ts`** — 监听 `terminal://session-replaced`

- 按 **leaf id + oldSessionId 双条件** 找到 TerminalPaneLeaf（防止 race 中 leaf 已经被另一次切换替换过）；都匹配才做替换
- Immer 迁移 `leaf.sessionId / leaf.providerId / leaf.resumeId / leaf.switching=false`
- Tab 单 pane 时同步 `Tab.sessionId / Tab.providerId / Tab.resumeId`
- 立刻触发一次前端 SavedSession 收集保存（调 `historyService` 的写盘路径，对齐 `App.tsx:249` 现有收集机制），确保 `session-replaced` 后 DB/snapshot 不滞后

**3. `web\components\panes\Panel.tsx`(Pane chrome 所在层) — 加 Provider 标识 + 菜单**

- 在 Pane 顶部条带（与现有 Tab 标题/close 同行的 chrome/notch 区）渲染当前 Provider 标识（如 `Claude · Anthropic` 或 `Claude · 自建代理 ⚠`，⚠ 表示 third_party）
- 点击标识 → DropdownMenu（**不是 ContextMenu**，避免和 xterm 右键冲突）
  - 列出当前 `cliTool` 兼容且 **同 trust level** 的 Provider；当前 providerId 标 ✓
  - 末尾一项 "允许跨信任级切换..." → 打开 confirm dialog（含警告："会把对话历史发到 third_party endpoint"），用户开关 `allowCrossTrust=true` 后菜单展开包含 third_party Provider
  - 没有 `resume_id` 的 session：每条 Provider 项前加小角标，hover 显示 "切换会丢失对话历史"
- 选中后：
  1. Immer 标 `leaf.switching = true` → Pane chrome 显示 "Switching to {name}..." 状态徽章 + xterm 上半透明 overlay 阻挡输入
  2. `await terminalService.switchSessionProvider({ ... allowCrossTrust })`
  3. `session-replaced` 事件回来后 store 自动清 `switching`
  4. SpawnFailed / InvalidArgument 用 sonner toast 显示，旧 session 保留（plan 决议#1 的好处兑现）

**4. xterm 不动**：保留默认右键复制/粘贴行为（M6 修复）

**5. `web\types\provider.ts` + `web\types\terminal.ts`**

- `Provider` interface 加 `trustLevel: "official" | "third_party"`
- `TerminalPaneLeaf` 加 `switching?: boolean`
- 加 helper：`getCompatibleProvidersForLeaf(leaf, providers, allowCrossTrust): Provider[]`，封装 cli_tool 兼容 + trust level 过滤逻辑

**6. i18n** — `web\i18n\locales\{en,zh-CN}\panes.json`

```
"switchProvider": "Switch Provider" / "切换 Provider"
"switching": "Switching to {{name}}..." / "正在切换到 {{name}}..."
"switchFailed": "Provider switch failed: {{error}}" / "切换失败：{{error}}"
"providerIncompatible": "Not compatible with {{cli}}" / "与 {{cli}} 不兼容"
"resumeWarning": "This session has no resume id; conversation history will be lost." / "此会话没有 resume id，对话历史将丢失。"
"crossTrustWarning": "Switching to a third-party endpoint will send your conversation history to {{provider}}. Continue?" / "切到第三方 endpoint 会把对话历史发送给 {{provider}}，确认继续？"
"allowCrossTrust": "Allow cross trust-level switch..." / "允许跨信任级切换..."
"providerTrustOfficial": "Official" / "官方"
"providerTrustThirdParty": "Third-party" / "第三方"
```

### 边界与已知限制

- **多 Pane 并发切换**：switch lock 按 session_id 维度互斥；不同 session 可并发。前端 leaf id + oldSessionId 双条件迁移避免 store 串抹。
- **没有 resume_id 的 session**：菜单显示警告；切换后是全新对话，不阻断但提醒。
- **WSL distro 缺失**：快照 `wsl.distro` 为 None 时复用 create_session 默认逻辑。
- **SSH 身份切换**：只切 Provider，SSH 连接信息（host/identity）保持不变。
- **dev/release 隔离**：所有路径已通过 `AppPaths` 抽象。
- **Codex CODEX_HOME 迁移**：旧 sessionId 目录在 ProviderSwitch kill 时不能删（按 sessionId 命名的目录可能被其他 session 占用）；按 resume_id 命名后切换天然指到同一目录，新旧不冲突。`prepare_isolated_codex_home` 内部要处理"目录已存在"是正常情况。

## 关键文件清单

修改：
- `cc-panes-core\src\models\provider.rs` — 加 `ProviderTrustLevel`、默认映射
- `cc-panes-core\src\services\terminal_service.rs` — `TerminalSession` 加快照字段；`KillReason` 枚举；`switch_session_provider`；`switch_locks`；`kill_with_reason`
- `cc-panes-core\src\services\terminal_service\wsl_codex.rs` — CODEX_HOME 路径按 resume_id 稳定
- `cc-cli-adapters\src\codex.rs` — `prepare_isolated_codex_home` 按 resume_id 命名
- `cc-panes-core\src\services\terminal_service.rs` — `build_ssh_command` 补 `--resume` 透传
- `src-tauri\src\commands\terminal_commands.rs` — `switch_session_provider` Tauri command（双 State 注入）
- `src-tauri\src\lib.rs` — 注册 invoke_handler
- `web\services\terminalService.ts` — `switchSessionProvider`
- `web\stores\usePanesStore.ts` — `terminal://session-replaced` 监听、双条件迁移、触发 SavedSession 立即收集
- `web\components\panes\Panel.tsx` — Pane chrome Provider 标识 + DropdownMenu（不是 ContextMenu）
- `web\types\provider.ts` — `trustLevel` 字段 + `getCompatibleProvidersForLeaf` helper
- `web\types\terminal.ts` — `TerminalPaneLeaf.switching?`
- `web\i18n\locales\{en,zh-CN}\panes.json` — 新文案

不改：
- `web\components\panes\TerminalView.tsx` — 保留 xterm 默认右键，不加 ContextMenu
- `cc-panes-core\src\models\provider.rs:48-140` `to_env_vars()` 主体逻辑
- `cc-panes-core\src\services\provider_service.rs` `get_env_vars()` 主体逻辑
- 现有 dead_buffers / replay_buffer / `kill_with_reason(Normal)` 流程
- `cc-panes-core\src\services\session_restore_service.rs` 写盘机制（前端触发即可）

## 验证

**单元测试**（Rust，`cc-panes-core\src\services\terminal_service.rs`）：
- `switch_rejects_cross_cli` — Claude session 切 OpenAI provider → InvalidArgument
- `switch_rejects_cross_trust_when_disallowed` — official → third_party 且 `allow_cross_trust=false` → InvalidArgument
- `switch_allows_cross_trust_when_user_optin` — `allow_cross_trust=true` 通过
- `switch_atomic_spawn_failure_preserves_old_session` — mock `spawn_pty` 抛错；切换返回 SpawnFailed；旧 session 仍在 sessions map
- `switch_concurrent_same_session_blocked` — 同 session 第二次 switch 在第一次完成前 → Conflict
- `switch_preserves_resume_id` — 新 ctx.resume_id 等于旧 resume_id
- `switch_kill_reason_provider_switch_no_session_killed_event` — 监听 emitter，确认不发 `session-killed`
- `switch_wsl_codex_codex_home_stable_by_resume_id` — 同 resume_id 切换两次，`prepare_isolated_codex_home` 返回同一路径

**前端单元测试**（Vitest）：
- `usePanesStore` 收到 `session-replaced` 事件按 leaf id + oldSessionId 双条件迁移；不匹配的 leaf 不动
- `getCompatibleProvidersForLeaf` 在 `allowCrossTrust=false` 时过滤掉 third_party
- DropdownMenu 在 Codex pane 上不显示 Anthropic provider；勾选 "允许跨信任级" 后才出现 third_party 项

**手动 E2E**（开发模式 `npm run tauri:dev`）：

1. **Local Claude + 同 trust**: 启 Claude tab 绑 Anthropic 官方 → Pane chrome 显 "Claude · Anthropic" → 点击 → 菜单里只看到官方类 provider（Bedrock/Vertex 等同 trust） → 选 Vertex → ~300ms 切换 → Tab 不闪关 → "你之前问的什么"得到正确回答（resume 生效）。
2. **跨 trust 拦截**: 同上但用户没开 allow_cross_trust → 菜单里看不到 Proxy / 第三方代理 → 末尾 "允许跨信任级切换..." 弹 confirm → 同意后菜单展开 → 选第三方 → confirm dialog 再次警告 → 切换成功 → 验证 Pane chrome 上 third_party 角标 ⚠ 显示。
3. **WSL Codex 切 provider + CODEX_HOME 复用**: 启 WSL Codex tab → 切到另一个 OpenAI 兼容 provider → 验证 `~/.codex/cdx-<resume_hash>` 目录被复用，conversations 历史可查询；切换后第二次再切回也命中同一目录。
4. **WSL Claude**: WSL Claude tab 切 provider → WSLENV 透传仍正常 → 对话延续。
5. **SSH Claude + resume**: SSH Claude tab 切 provider → 验证 `build_ssh_command` 拼了 `--resume <id>`（看日志或 ps）→ 远程 claude 进程实际跑 `--resume` 且对话延续。
6. **原子失败 + 旧 session 保留**: mock 一个不存在的 provider config → 触发 `spawn_pty` 失败 → 验证 sonner toast 报错 → **旧 session 不变**，仍可正常用。
7. **kill 不误关**: 切 provider 期间观察前端 → Tab 不关闭（M1 修复生效）。
8. **并发拦截**: 在 switch 进行中再次点切换 → 第二次报 Conflict（M3 switch lock 生效）。
9. **TaskBinding 同步**: 在 leader pane 切 provider → `task_bindings` 表里 sessionId 已更新；worker 后续 `report_to_leader` 能到达新 PTY。
10. **SavedSession 同步**: 切换后立即关 app 再重启 → 恢复出来的 Tab providerId/sessionId/resumeId 都是新值（M5 修复生效）。
11. **无 resume_id 警告**: 找一个没 resume_id 的 session（极少见）→ 菜单项显示角标 → hover 看到警告文案。

**质量检查**（提交前）：
```bash
npx tsc --noEmit
npm run test:run
cargo check --workspace
cargo clippy --workspace -- -D warnings
cargo test --workspace
```

---

## 实施切片建议（供后续 task 拆分参考）

可分 4 个 PR/iteration 落地，每片独立可测：

1. **Slice 1 — Provider 模型与 trust level**：`ProviderTrustLevel` 枚举、默认映射、`getCompatibleProvidersForLeaf` helper、TS 类型、前端"允许跨信任级"开关 UI。不引入切换功能，仅打基础。
2. **Slice 2 — 后端原子双 PTY + KillReason + switch_locks**：`TerminalSession` 补字段、`KillReason::ProviderSwitch`、`switch_session_provider` 主体、`switch_locks`、`session-replaced` 事件、Tauri command 双 State 注入。覆盖 Local runtime + 单元测试。
3. **Slice 3 — WSL / SSH / Codex CODEX_HOME 收尾**：CODEX_HOME 按 resume_id 命名、`build_ssh_command` 补 `--resume`、WSL Codex / SSH 路径手动 E2E。
4. **Slice 4 — Pane chrome UI 入口 + 双条件迁移 + 状态同步**：Panel.tsx Provider 标识 + DropdownMenu、usePanesStore 监听、SavedSession 立即收集触发、TaskBinding / LaunchHistory command 层同步、i18n、E2E 走通。
