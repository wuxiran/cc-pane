# 阶段 12：GUI 高级功能（已完成）

## 目标

实现窗口管理、会话工具、高级 UI 功能。

## 状态

✅ 已完成

## 任务清单

### 已完成

- [x] 会话日志面板 (JournalPanel.tsx) - 工作空间级别的日志记录
- [x] 会话修复面板 (SessionCleanerPanel.tsx) - 清理异常会话
- [x] 文件历史面板 (LocalHistoryPanel.tsx) - 查看和恢复文件历史版本
- [x] Worktree 管理器 (WorktreeManager.tsx) - Git worktree 管理
- [x] Git 时间线与内容 Diff - 本地分支、提交文件、merge parent 对比
- [x] 工作空间别名 - 自定义工作空间显示名称
- [x] 项目别名 - 自定义项目显示名称
- [x] 侧边栏右键菜单（工作空间级 / 项目级）
- [x] 迷你悬浮窗模式 - `MiniView.tsx`
- [x] 系统托盘（后台运行） - `lib.rs` TrayIconBuilder
- [x] 快捷键系统 - `tauri_plugin_global_shortcut`
- [x] 设置面板 - `SettingsPanel.tsx` + 9 个 Section

### 待实现

- [ ] 窗口置顶 (Pin) 功能
- [ ] N宫格状态指示组件
- [ ] CC 状态实时监控

## 已完成功能说明

### 会话日志面板 (JournalPanel)

工作空间级别的操作日志，记录用户在该工作空间下的关键操作历史。以面板形式嵌入分屏系统中。

### 会话修复面板 (SessionCleanerPanel)

用于检测和清理异常的 Claude Code 会话（如残留进程、损坏的会话文件等）。

### 文件历史面板 (LocalHistoryPanel)

类似 JetBrains IDE 的 Local History 功能，自动记录文件变更历史，支持查看 diff 和恢复到历史版本。

### Worktree 管理器 (WorktreeManager)

管理 Git worktree，方便在多个分支间并行工作。每个 worktree 可以关联独立的 Claude Code 实例。

### Git 时间线与内容 Diff

Explorer 的 Git 分组提供提交时间线入口，分支选择首版只列本地分支。提交分页由后端显式返回 `hasMore` 和 `nextOffset`；日志进程使用 NUL 结尾的固定字段协议，任一记录畸形时整次请求失败，不跳过坏记录。

提交详情按 `GitChangedFile` 展示 old/new path 与 mode，可表达新增、删除、重命名、symlink 和 submodule。root commit 与 unborn worktree 的缺失侧按空内容处理；merge commit 默认对比 first parent，并可切换其他 parent。Explorer 未提交文件入口标为“工作区 vs HEAD · 内容对比”，不表示 index 或元数据级比较。

Diff 内容复用 Local History 的 `HistoryFileRepository::compute_diff` 和前端 `DiffView`。读取前先在 raw bytes 上判断 binary，再做 UTF-8/GBK 解码；5 MB 文件上限与 10000 行上限分别返回截断原因和两侧字节数。读取文件大小配置只读 `.ccpanes/config.toml`，不会打开或迁移 History SQLite。

Tauri 命令与 Web API 都是 core `GitService` 的薄包装，异步读取在线程池中执行。前端 log、文件列表和 diff 各自使用 request-id，切分支、切提交或切文件后会丢弃过期响应。

回滚顺序固定为 **C2 -> C1**：先移除时间线/diff UI、新 service 方法及新增命令/路由，再回滚 C1 的 GitService、runner 和安全固化。不得先撤 C1，否则 C2 会失去受限输出、修订固化和路径校验基础。

### 别名功能

工作空间和项目均支持自定义别名，侧边栏优先显示别名，方便识别和管理。

## 待实现功能说明

### 窗口置顶 (Pin)

始终显示在最上层，方便监控。

### N宫格状态指示 / CC 状态实时监控

实时显示各 Claude Code 实例的运行状态指标。

## 下一步

完成阶段 12 后，进入 [阶段 13：打包发布](./13-packaging.md)。
