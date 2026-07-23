# 阶段 5：Local History（已完成）

## 目标

实现类似 IntelliJ IDEA 的本地文件历史功能，自动保存文件更改，支持恢复到任意时间点。

## 状态

✅ 已完成

## 任务清单

- [x] 文件版本存储 API (`local_history_commands.rs`)
- [x] 历史配置管理
- [x] 版本恢复 API
- [x] 前端面板 (`LocalHistoryPanel.tsx`)
- [x] 前端服务 (`localHistoryService.ts`)
- [x] Diff 计算与展示
- [x] 标签系统（版本标记）
- [x] 分支感知（记录当前 Git 分支）
- [x] 压缩存储 (flate2)
- [x] 目录级历史浏览
- [x] 自动清理策略（按时间、按大小）

## 存储结构

```
<project>/.ccpanes/history/<file_hash>/
├── meta.json              # 元数据
├── base.snapshot.gz       # 基准快照
└── <timestamp>.diff.gz    # 增量差异
```

## 实际文件位置

**后端:**

- `src-tauri/src/commands/local_history_commands.rs` — Tauri 命令接口
- `src-tauri/src/services/history_service.rs` — 历史业务逻辑
- `src-tauri/src/repository/history_file_repo.rs` — 历史文件存储仓库

**前端:**

- `src/components/LocalHistoryPanel.tsx` — 历史浏览面板
- `src/services/localHistoryService.ts` — 前端服务层

## 依赖

```toml
# src-tauri/Cargo.toml 相关依赖
notify = "7"              # 文件监控（待集成）
similar = "2"             # diff 计算（待集成）
sha2 = "0.10"             # 文件哈希
flate2 = "1"              # 压缩存储
```

## 下一步

完成阶段 5 后，进入 [阶段 6：Skill 系统](./06-skill-system.md)

## 文件监听生命周期

桌面端 Local History 使用原生 `notify::RecommendedWatcher`，但不再在应用启动时监听全部注册项目。`HistoryWatchManager` 只为存在活跃终端会话的本地项目启动 watcher；同一项目的多个会话共享一个 watcher，最后一个会话结束后保留 45 秒宽限，再释放 watcher。

Windows 的 `ReadDirectoryChangesW` 需要持有被监听目录的句柄，因此仍可能阻止目录重命名或删除。当前锁面限定为“有活跃会话的项目 + 最后会话结束后 45 秒宽限内的项目”，而不是所有注册项目。删除项目、删除或重命名工作空间、项目迁移以及关闭全局 Local History 开关都会立即释放对应 watcher。

设置页的全局 Local History 开关优先于项目级 `config.history.enabled`。关闭会停止全部 watcher 并拒绝新会话启动监听；重新开启不会扫描所有项目，只由之后创建的新会话按需恢复。

排障时可通过桌面 Tauri 命令 `get_history_watch_stats` 读取：

```json
{
  "watchingProjects": 1,
  "sessionCount": 2
}
```

`cc-panes-web` 会复用“初始化历史仓库不启动 watcher”的 core 行为，因此不会恢复旧的全量监听；但 web 端终端路由尚未接入 `HistoryWatchManager`，也没有对应的 HTTP stats 路由。这是当前已知残留，桌面命令返回的 stats 仅代表桌面进程内的 watcher。
