# 62 · Worktree 项目嵌套显示与残留记录回收

## 症状

侧边栏某个工作空间铺了 21 条同级项目，其中 19 条是 `cc-book-wt-*` 形态的 git worktree，主仓库淹没在里面。右侧 Git 面板显示其中 14 条「项目路径不存在」，但侧边栏毫无标记，也没有任何清理入口。

实测 `~/.cc-panes/workspaces/cc-book/workspace.json`：21 个项目里 14 个的 `path` 指向已删除目录，形态是 `\\wsl.localhost\Ubuntu\mnt\d\04_workspace_rust\cc-book-wt-b` 这类 WSL UNC（规范化后等价于 `D:\04_workspace_rust\cc-book-wt-b`，磁盘上早已不存在）。

## 根因：写入自动化、删除手动化

不是某处的 bug，是四个缺口叠加出的单向流：

1. **创建端有两条不对称通道**。UI 的 `WorktreeManager` / Launcher 建 worktree **不注册** Project；而 skill 流程（plantocodex / plantoworktree / fanout-compare）和 `ScanImportDialog` **一定注册**，fanout 一次注册 N 个。注册量由 AI 派活频率驱动。
2. **删除端完全不联动**。`worktree_service.rs::remove_worktree` 只跑 `git worktree remove`，不碰 workspace.json；`workspace_service.rs::remove_project` 只删记录，不碰磁盘。两侧唯一的桥梁曾经只是文档里一句「提醒用户在 UI 手动移除」——而 MCP 刻意不提供 `remove_project`，AI 就算想自清理也没工具。
3. **模型没有溯源信息**。`WorkspaceProject` 只有 `{id, path, alias, launchProfileId, wslRemotePath, ssh}`，没有 `isWorktree` / `parentRepo` / `branch`。
4. **没有存在性回收**。`add_project` 不校验路径存在（与 `project_service.rs` 的 SQLite 路线行为不一致）；加载时 `repair_persisted_project_path` 修不好就原样保留；列表渲染无失效标记。孤儿项目在 UI 上和正常项目长得一模一样。

**关键判断：嵌套显示单独修不了「21 条平铺」。** 路径不存在的项目跑不了 `git worktree list`，永远归不了组、仍会平铺。两件事必须一起做。

## 方案

### 1. worktree 归属：运行时派生，不加持久化字段

关系永远等于 git 真相、自愈、零迁移成本；持久化 `parentProjectId` 唯一的优势（对已删除路径保留归属）恰好被清理机制消灭。

数据源是 `useWorkspaceActions` 里**早就在跑但从没人消费**的 `worktreeCache`（workspace 展开时对每个项目跑 `git worktree list --porcelain`）。

核心算法在 `web/components/sidebar/worktreeGrouping.ts`：

> **不能**把「A 的 worktree 列表里有 B」当成「B 是 A 的子节点」——`git worktree list` 从任何一个 worktree 跑都返回同一份全量列表，那样会互认成环。

改为把列表当**分组键**：

```
repoKey(p) = projectIdentityKey( worktreeCache[p.path].find(e => e.isMain).path )
```

同一 repo 的所有项目（含主仓库自己）算出同一 repoKey，父节点唯一确定为 `identityKey(自身路径) === repoKey` 的那一个。结构上深度恒为 1、不可能成环。

四条必须保留的边界处理：

| 情况 | 处理 | 理由 |
|---|---|---|
| 主仓库未加入工作空间 | 全部退回顶层平铺 | 不让某个 worktree 冒充父节点——右键「Worktree 管理」会以错误的 repo root 打开 |
| monorepo 子目录项目 | 守卫：自身路径必须是列表里一条**非 main** 的 worktree 根，否则平铺 | `D:\repo\packages\api` 跑 git 同样返回 `D:\repo` 作为 main，会被误认成假 worktree |
| 同一主仓库重复注册 | 后来者做父节点，前一条降级为顶层 | 绝不静默吞掉任何项目 |
| 缓存未就绪 / SSH / 路径不存在 | 平铺 | 交给清理机制 |

折叠状态存 `useLayoutUiStore.expandedWorktreeGroups`，注意是「**展开**列表」不是「折叠列表」：默认必须收起，用 `collapsed*` 语义就得预先塞入所有 key，做不到。键用 repoKey 而非 `project.id`——项目移除再导入时 id 会变。

### 2. 路径存在性：三态，不是布尔

`cc-panes-core/src/services/workspace_health.rs`：

```rust
pub enum PathStatusKind { Present, Missing, Unverifiable }
```

**陷阱**：直接 `Path::new(p).exists()` 会把合法的 `/mnt/d/x` 判成 missing。必须先过 `canonical_project_path` 规范化再探测。

`Unverifiable` 覆盖 SSH 远程项目与「规范化后仍是 WSL UNC 且发行版未运行」——那种状态下无法区分「路径真没了」与「暂时看不到」，判成 Missing 会诱导用户误删仍然有效的注册。清理对话框里 `Unverifiable` **默认不勾选**，这是「非破坏性默认」的落点。

命令 `check_workspace_project_paths` + REST `GET /api/workspaces/{name}/project-path-status` 双端对等。

### 3. 清理：标红 + 手动批量确认，只删记录

- 失效项目行：`FolderX` 图标 + 删除线 + 红色徽章（复用现有 i18n key `explorer.gitPathNotFound`），并裁剪必然失败的菜单项（Worktree 管理 / Migrate / 新建 Spec）
- 顶部内联横幅「N 个项目路径已不存在 · 清理」（持久状态用内联而非 toast，见 `docs/46-frontend-styleguide.md` §1）
- `MissingProjectsCleanupDialog` 列出待移除条目，文案显式声明**仅从工作空间移除记录，不会删除磁盘上的任何文件**
- 探测失败一律静默：绝不能因为一次 IPC 失败就把项目标红或隐藏

磁盘还在但已不是 git worktree 的目录（`.git` 指向已 prune 的 admin 目录，Git 面板显示「非 Git 项目」）**只标记不进清理清单**——那类目录里可能还有未提交的改动。

### 4. 堵源头

`WorktreeManager` 删除成功后回调 `onWorktreeRemoved`，`useProjectHygiene.handleWorktreeRemoved` 遍历**全部**工作空间（worktree 可能被导入到与主仓库不同的工作空间），按 `projectPathsEquivalent` 匹配后移除记录。

两条纪律：

- 联动包 try/catch。git 那一步已经成功了，联动失败不能让删除动作看起来失败。
- 必须同时调 `invalidateWorktrees` 清 `requestedWorktrees` ref + 缓存条目。否则 ref 去重会让删/加 worktree 后不再重新探测，分组树保持陈旧。

Rust 侧**不动**：`remove_worktree` 保持只跑 git，编排归应用层（符合 Command → Service → Repository 分层）。

## 关键文件

| 文件 | 职责 |
|---|---|
| `cc-panes-core/src/services/workspace_health.rs` | 三态路径判定 |
| `src-tauri/src/commands/workspace_commands.rs` | `check_workspace_project_paths` |
| `cc-panes-web/src/routes/resources.rs` | REST 对等 |
| `web/components/sidebar/worktreeGrouping.ts` | 分组算法（纯函数） |
| `web/components/sidebar/ProjectListItem.tsx` | 单行 + 右键菜单 + 失效降级 |
| `web/components/sidebar/ProjectListView.tsx` | 分组渲染 + 横幅 |
| `web/components/sidebar/useProjectHygiene.ts` | 路径状态 + 清理 + 删除联动 |
| `web/components/sidebar/MissingProjectsCleanupDialog.tsx` | 批量清理确认 |
| `web/stores/useLayoutUiStore.ts` | `expandedWorktreeGroups` |

## 遗留

- 清理入口目前只覆盖当前展开的工作空间。跨全部工作空间的一次性扫描留待后续。
- 主仓库未注册时只是平铺，没有「导入主仓库」的引导动作。
