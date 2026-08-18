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
<project>/.ccpanes/history/
├── history.db             # SQLite：版本/标签/快照元数据（WAL 模式）
└── blobs/<sha256>         # 内容寻址的文件内容，按 SHA256 去重
```

> **注意**：早期版本曾使用 `history/<file_hash>/{meta.json, base.snapshot.gz, *.diff.gz}` 的
> 每文件目录 + 增量差异布局，**该布局已淘汰**。`HistoryFileRepository::migrate_from_json()`
> 保留了从旧 `versions.json` 的一次性迁移路径。写新代码请勿参照旧布局。

三张表：`file_versions`（`(file_path, id)` 主键）、`labels`、`label_snapshots`。
`file_path` 存**项目相对路径且统一用 `/` 分隔**，因此库本身跨机器可移植。

blob 的压缩是**可选的后置维护动作**，不是写入时默认行为：`compress_blobs()` 会把
gzip 后更小的 blob 就地替换，读取侧（`read_blob`）靠魔数嗅探自动解压。所以
`blobs/` 下同时存在裸文件与 gzip 文件是正常状态。

## 实际文件位置

**后端**（领域逻辑在 `cc-panes-core`，`src-tauri` 只剩命令薄层）：

- `src-tauri/src/commands/local_history_commands.rs` — Tauri 命令接口
- `cc-panes-core/src/services/history_service.rs` — 历史业务逻辑
- `cc-panes-core/src/repository/history_file_repo.rs` — 存储仓库（SQLite + blobs）
- `cc-panes-web/src/routes/history.rs` — Web/daemon 侧 REST 路由

**前端**（路径别名 `@/` → `web/`）：

- `web/components/LocalHistoryPanel.tsx` — 历史浏览面板
- `web/services/localHistoryService.ts` — 前端服务层

## 依赖

```toml
# cc-panes-core/Cargo.toml（src-tauri/Cargo.toml 同步持有）
notify   = "7"            # 文件监控（已集成，见下节 watcher 生命周期）
similar  = "2"            # diff 计算（已集成）
sha2     = "0.10"         # 内容寻址哈希
flate2   = "1"            # blob 可选压缩
rusqlite = *              # history.db
```

## Schema 迁移现状

`history.db` **没有 `PRAGMA user_version`**，迁移靠 `migrate_add_branch()` 里捕获
`"duplicate column"` / `"already exists"` 错误字符串实现幂等。这与全局 `data.db` 的
`schema_migrations` + `user_version` 正规做法不一致，属已知技术债：SQLite/rusqlite
若改动错误文案，该判断会静默退化成硬失败。改动本表结构前应先补上版本号机制。

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
