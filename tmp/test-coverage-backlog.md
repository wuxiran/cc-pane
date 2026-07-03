# 测试全补 — 批次计划（leader/worker 编排）

> Leader: 主 Claude 会话（不写代码，负责拆分/派发/监控/汇总）
> 执行方式：worktree 隔离的 worker，分波次边写边验（cargo test / vitest 必须绿）
> 范围：字面全补（后端零测试文件 + 前端 store/service/hooks + 136 组件）
> CI：已改阶梯门槛（vitest autoUpdate + CI 跑 test:coverage）

## 铁律（写进每个 worker prompt）
- 只加测试，不改被测实现（除非为可测性做无行为变更的最小重构，并说明）。
- 遵循 CLAUDE.md：core 用 `:memory:` SQLite 测试；小函数小文件；错误显式。
- 会话状态测试只针对 OSC/hook 通道，禁止文本模式匹配（见 CLAUDE.md Gotcha）。
- 终端提交路径回车是 `\r`，测试勿断言成 `\n`。
- 收尾：`update_task_binding(completed,100)` + `report_to_leader(completed)`。
- worker 不 commit，改动留在自己 worktree，leader 汇总。

## 后端波次（Rust，附加 #[cfg(test)] 模块，文件不相交）

### Wave B1（最高价值零测试）
- [ ] B1a worktree_service.rs（cc-panes-core/src/services/）— Git worktree 逻辑
- [ ] B1b pty/mod.rs + pty/job.rs + terminal_service/shell.rs
- [ ] B1c claude_session_service.rs（对齐 codex_session_service 的 14 个测试）
- [ ] B1d ssh_credential_service.rs（安全敏感）

### Wave B2（core 其余零测试 service）
- [ ] B2a workspace_service / settings_service / provider_service
- [ ] B2b plan_service / journal_service / launch_history_service
- [ ] B2c filesystem_service / session_restore_service / project_context_service / user_skill_service
- [ ] B2d utils/command.rs + utils/app_paths.rs；cc-panes-api/error.rs

### Wave B3（src-tauri 桌面特有服务 + IPC 命令）
- [ ] B3a src-tauri services 零测试：screenshot_overlay / session_prompt_service / skill_market_service / resume_binding_service
- [ ] B3b src-tauri commands 层（38 文件）→ 拆 3-4 个 worker 按域分（git/worktree/project/workspace | terminal/launch/runner | skill/spec/todo/memory | provider/settings/ssh/window/...）
- [ ] B3c cc-panes-web 零测试路由：system / process / journal / agent_sessions

## 前端波次（TS/React）

### Wave F1（stores 零测试，20 个）
- [ ] F1a 编排链：useOrchestratorStore / useOrchestratorSync（hook）/ useRunnerStore
- [ ] F1b 业务链：useTodoStore / useSpecStore / useLaunchProfilesStore
- [ ] F1c 编辑器/文件：useEditorTabsStore / useFileTreeStore / useFileBrowserStore
- [ ] F1d 其余：useCCChanStore / useNotificationStore / useProcessMonitorStore / useResourceStatsStore / useSelfChatStore / useSharedMcpStore / useSshMachinesStore / useUpdateStore / useUsageStatsStore / useVoiceInputStore / useActivityBarStore / useMiniModeStore

### Wave F2（services 零测试，23 个）
- [ ] F2a 会话/运行：codexService / cliToolService / runnerService / processService / sessionRestoreService
- [ ] F2b 功能：planService / specService / todoService / sharedMcpService / mcpConfigService
- [ ] F2c 其余：filesystemService / layoutSwitcherService / logService / popupWindowService / screenshotService / selfChatService / sshMachineService / updaterService / usageStatsService / voiceService / webAuthService / workspaceSnapshotService / runtime

### Wave F3（hooks 零测试，~30 个）
- [ ] F3a 会话/PTY 数据流 hooks
- [ ] F3b Git/工作区 hooks
- [ ] F3c UI 交互 hooks

### Wave F4（components，136 个 .tsx）—— 按子目录拆多 worker
- [ ] ui/（基础库）· settings/ · editor/ · explorer/ · filetree/ · home/ · memory/ · mobile/ · orchestration/ · selfchat/ · skill/ · todo/ · panes/ · sidebar/ · providers/

## 汇总表（leader 维护）
| Wave | Worker | 文件范围 | worktree | 状态 | diff stat | 备注 |
|------|--------|----------|----------|------|-----------|------|
| B1 | B1a | worktree_service.rs | | pending | | |
