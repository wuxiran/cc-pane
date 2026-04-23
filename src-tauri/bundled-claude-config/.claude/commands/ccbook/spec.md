# CC-Panes Spec 工作流

CC-Panes 项目专属的 Spec 驱动开发工作流。管理 Spec 文档与 Todo 任务的双向绑定。

---

## 系统概述

CC-Panes 内置了完整的 **Spec + Todo** 系统：

- **Spec**：一份 Markdown 规格文档，存储在 `<project>/.ccpanes/specs/` 目录
- **Todo**：关联的任务跟踪项，支持子任务拆解
- **双向绑定**：Spec 文件中的 `## Tasks` 段与 Todo 子任务自动同步

### 状态流转

```
Draft → Active → Archived
  ↑       ↓
  └── (可回退)
```

- **Draft**：起草中，可编辑内容和任务
- **Active**：进行中，同一项目只能有一个 Active Spec
- **Archived**：已完成，文件移至 `specs/archived/` 目录

### 文件存储

```
<project>/.ccpanes/specs/
├── my-feature.spec.md          # Draft/Active Spec
└── archived/
    └── 20260315_old-spec.spec.md  # 归档的 Spec
```

## 通过 MCP 工具管理

CC-Panes 的 `ccpanes` MCP 服务器提供了 Spec 和 Todo 的管理工具。

### 创建 Spec

```
调用 ccpanes.create_todo 工具:
  title: "功能名称"
  scope: "project"
  scopeRef: "<project-path>"
  todoType: "spec"
```

或通过前端 specService 的 `create` 方法（自动创建 Spec 文件 + Todo + 子任务）。

创建时可附带初始任务列表：

```typescript
specService.create({
  projectPath: "/path/to/project",
  title: "添加暗黑模式",
  tasks: ["定义 CSS 变量", "实现主题切换组件", "适配所有页面"]
})
```

### 任务跟踪

```
查看任务:  ccpanes.query_todos  → scope=project, scopeRef=<path>
更新状态:  ccpanes.update_todo  → todoId=<id>, completed=true
```

### 双向同步机制

1. **Todo → Spec 文件**：Todo 子任务状态变更后，调用 `sync_spec_tasks` 同步到 Spec 文件的 `## Tasks` 段
2. **Spec 文件 → Todo**：AI 在 Spec 文件中打勾 `- [x]` 后，`sync_spec_tasks` 会回收这些改动到 Todo
3. **终端退出自动日志**：终端关闭时自动执行 `git diff --stat HEAD`，将变更记录追加到 Spec 的 `## Log` 段

## Spec 文件结构

每个 Spec 文件由 4 个核心段组成：

```markdown
# Spec: 功能标题
> Status: draft | Created: 2026-03-15

## Proposal
变更动机和目标。
- 为什么需要这个功能？
- 解决什么问题？
- 预期效果是什么？

## Design
技术方案。
- 架构设计
- 组件拆分
- 接口定义

### Affected Files
- `src/xxx.ts` [ADDED]
- `src/yyy.ts` [MODIFIED]
- `src/zzz.ts` [DELETED]

## Tasks (auto-synced from CC-Panes)
<!-- 此段由 CC-Panes 自动同步，请在 Todo 面板中编辑 -->
- [ ] 任务 1
- [x] 任务 2（已完成）
- [ ] 任务 3

## Log
### 2026-03-15
- ADDED `src/foo.ts`
- MODIFIED `src/bar.ts`
```

各段说明：

| 段 | 用途 | 编辑方式 |
|----|------|----------|
| **Proposal** | 变更动机、目标 | 手动编写 |
| **Design** | 技术方案、影响文件 | 手动编写 |
| **Tasks** | 任务 checkbox 列表 | 自动同步（通过 Todo 面板编辑） |
| **Log** | 变更日志 | 自动追加（终端退出时） + 手动补充 |

## 推荐流程

### 完整流程（大功能）

1. **规格设计**：用 `/ccbook:openspec` 引导，按 Proposal → Design → Tasks 结构编写 Spec 文档
2. **创建 Spec**：在 CC-Panes 中创建 Spec（通过 `specService.create` 或 `ccpanes.create_todo`）
3. **激活 Spec**：将 Spec 状态改为 Active
4. **执行任务**：逐个完成子任务，AI 在终端中工作时自动同步进度
5. **归档 Spec**：所有任务完成后，将 Spec 归档

### 简化流程（小功能）

1. 直接创建 Spec + 任务列表
2. 激活 → 执行 → 归档

## 常见操作速查表

### 创建 Spec

```
通过 ccpanes MCP:
  create_todo(title, scope="project", scopeRef=<path>, todoType="spec")

通过前端 Service:
  specService.create({ projectPath, title, tasks: [...] })
```

### 查看 Spec 列表

```
通过 ccpanes MCP:
  query_todos(scope="project", scopeRef=<path>, todoType="spec")

通过前端 Service:
  specService.list(projectPath, status?)  // status: "draft" | "active" | "archived"
```

### 读取 Spec 内容

```
specService.getContent(projectPath, specId)
```

### 更新 Spec 状态

```
specService.update(specId, { status: "active" })   // 激活
specService.update(specId, { status: "archived" })  // 归档
specService.update(specId, { status: "draft" })     // 回退为草稿
```

### 同步任务

```
specService.syncTasks(projectPath, specId)
```

双向同步：Todo 面板的子任务状态 ↔ Spec 文件的 `## Tasks` checkbox。

### 追加日志

终端退出时自动执行（`handle_terminal_exit_spec`）：
1. 查找当前项目的 Active Spec
2. 同步 Tasks（回收 AI 的 checkbox 改动）
3. 执行 `git diff --stat HEAD`
4. 将 diff 结果追加到 Spec 的 `## Log` 段

### 删除 Spec

```
specService.delete(projectPath, specId)
```

级联清理：Todo 子任务 → Todo → Spec 文件 → DB 记录。

## 注意事项

- 同一项目同一时间只能有 **一个 Active Spec**，激活新 Spec 会自动取消前一个
- `## Tasks` 段由系统自动管理，不要手动编辑（通过 Todo 面板操作）
- 归档操作不可逆（文件移至 `archived/` 并添加日期前缀）
- Spec 文件名由标题自动生成（`title-slug.spec.md`），支持中文
