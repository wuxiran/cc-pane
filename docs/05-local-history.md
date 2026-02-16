# 阶段 5：Local History（部分完成）

## 目标

实现类似 IntelliJ IDEA 的本地文件历史功能，自动保存文件更改，支持恢复到任意时间点。

## 状态

🔨 部分完成

## 任务清单

### 已实现

- [x] 文件版本存储 API (`local_history_commands.rs`)
- [x] 历史配置管理
- [x] 版本恢复 API
- [x] `LocalHistoryPanel.vue` 前端面板
- [x] `localHistoryService.ts` 前端服务

### 待实现

- [ ] 文件监控器 (notify crate watcher)
- [ ] 自动保存触发机制
- [ ] Diff 计算与增量存储 (similar crate)
- [ ] 自动清理策略（按时间、按大小）
- [ ] 历史浏览 UI 完善（时间线、diff 预览）

## 存储结构

```
<project>/.ccpanes/history/<file_hash>/
├── meta.json              # 元数据
├── base.snapshot.gz       # 基准快照
└── <timestamp>.diff.gz    # 增量差异
```

## 当前实际文件位置

**后端:**

- `src-tauri/src/commands/local_history_commands.rs` — Tauri 命令接口
- `src-tauri/src/repository/history_file_repo.rs` — 历史文件存储仓库

**前端:**

- `src/components/LocalHistoryPanel.vue` — 历史浏览面板
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
