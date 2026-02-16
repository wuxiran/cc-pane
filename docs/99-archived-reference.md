# 旧代码参考文档

> **旧代码位置**：`_archived_v1/crates/`
>
> **新代码位置**：`src-tauri/src/`
>
> 本文档整理旧代码中可参考的实现和需要避免的问题。

> **架构变更说明**：当前项目已不再使用 `cc-panes-core` 独立 crate 架构，而是将所有后端逻辑直接放在 `src-tauri/src/` 下（commands/ + services/ + models/ + db/）。旧代码中的模块划分仍有参考价值，但路径和调用方式已完全不同。

## 可参考的功能模块

### 1. 本地历史系统（高优先级）

**位置**：`cc-panes-core/src/history/`

| 文件 | 功能 | 参考价值 |
|------|------|---------|
| `storage.rs` | 版本存储、清理 | 高 |
| `diff.rs` | 文件差异计算 | 中（逻辑有 bug） |
| `restore.rs` | 版本恢复 | 中（逻辑有 bug） |
| `watcher.rs` | 文件监控 | 高 |

**需要改进**：
- `diff.rs:74` - diff 应用逻辑错误，用字符串 replace 无法正确回放 unified diff
- `restore.rs:47` - is_current 标记错误，应该标记最新版本而非第一条
- `storage.rs:158` - 清理只删 diff 文件，不更新 meta，会导致恢复退化
- `watcher.rs:139` - save_version 错误被吞掉，应该记录日志

**建议**：使用成熟的 diff 库（如 `similar`）而不是自己实现。

---

### 2. 平台适配层

**位置**：`cc-panes-core/src/platform/`

| 文件 | 功能 | 参考价值 |
|------|------|---------|
| `windows/wt.rs` | Windows Terminal 启动 | 中 |
| `linux/tmux.rs` | tmux 分屏 | 中 |
| `macos/iterm2.rs` | iTerm2 分屏 | 低（未完成） |

**需要改进**：
- `wt.rs:220` - Grid4x4 只创建 4 个 pane，应该是 16 个
- `tmux.rs:97` - send-keys 目标写成 `session:i`（窗口索引），应该是 pane 索引
- `iterm2.rs` - 只做分割，不设置工作目录/命令

**注意**：新设计使用内置 PTY 终端（portable-pty + xterm.js），不再依赖外部终端。但如果后续要支持"在外部终端打开"功能，可以参考。

---

### 3. 远程 API

**位置**：`cc-panes-core/src/remote/`

| 文件 | 功能 | 参考价值 |
|------|------|---------|
| `server.rs` | HTTP 服务器 | 高 |
| `handlers/` | API 处理器 | 中 |

**需要改进**：
- `server.rs:46` - 各 Service 独立加载配置快照，创建项目后 LaunchService 仍是旧数据
- `handlers/mod.rs:42` - API 统一返回 400，缺少 404/500 等语义化错误
- `handlers/launch.rs:51` - 快速启动创建的 Task 未持久化

**建议**：使用共享状态或事件机制保持服务间同步。

---

### 4. Skill 系统

**位置**：`cc-panes-core/src/skills/`

| 文件 | 功能 | 参考价值 |
|------|------|---------|
| `parser.rs` | 技能解析 | 中 |
| `loader.rs` | 技能加载 | 中 |

**需要改进**：
- `loader.rs:27` - 直接 unwrap，解析失败会 panic
- 存在两套解析实现（SkillParser vs SkillService::parse_frontmatter），容易不一致

---

### 5. 服务层

**位置**：`cc-panes-core/src/services/`

| 文件 | 功能 | 参考价值 |
|------|------|---------|
| `launch_service.rs` | 启动管理 | 中 |
| `project_service.rs` | 项目管理 | 高 |
| `workspace_service.rs` | 工作空间管理 | 高 |
| `document_service.rs` | 文档管理 | 低 |
| `skill_service.rs` | 技能服务 | 低 |

**需要改进**：
- `launch_service.rs:70` - 用枚举序号当 pane_id，应使用 pane_index
- `launch_service.rs:82` - 临时 Task 未持久化，状态列表永远空
- `project_service.rs:31` - 只校验 path 存在，不校验是否为目录
- `document_service.rs:151` - 搜索每次全量读文件，缺乏索引

---

## 通用问题清单

### 错误处理
- [ ] 避免直接 unwrap，使用 `?` 或 `anyhow`
- [ ] 不要吞掉错误（`let _ = ...`），至少记录日志
- [ ] API 返回语义化错误码（404/500 等）

### 数据一致性
- [ ] 服务间共享状态或使用事件同步
- [ ] 临时数据也要考虑是否需要持久化
- [ ] 清理操作要完整（删文件 + 更新索引）

### 性能
- [ ] 批量操作考虑并行
- [ ] 大文件操作考虑流式处理
- [ ] 频繁读取考虑缓存

### 代码规范
- [ ] 避免重复实现（如两套解析器）
- [ ] 语义要统一（如 pane_id vs pane_index）
- [ ] 参数校验要完整（如目录 vs 文件）

---

## 后续开发计划

按阶段规划排序：

1. **阶段 9**：远程访问 - 待设计，支持移动端远程监控
2. **阶段 10**：测试 - Rust 单元测试/集成测试 + 前端测试 + CI/CD
3. **阶段 11**：Tauri GUI 基础 - ✅ 已完成
4. **阶段 12**：GUI 高级功能 - 🔨 部分完成（会话工具已完成，窗口管理待实现）
5. **阶段 13**：打包发布 - 跨平台打包 + 自动更新 + GitHub Release
