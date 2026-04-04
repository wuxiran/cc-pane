# OpenSpec — Spec 驱动开发方法论

引导用户使用 CC-Panes 内置 Spec 系统进行 Spec 驱动开发。

---

## 什么是 OpenSpec

OpenSpec 是一种 **先规格、后代码** 的开发方法论。核心理念：

- 每个功能变更先写 **Spec 文档**（Proposal → Design → Tasks），审核后再编码
- 所有决策留痕：Spec 文档记录 Why / What / How
- AI Agent 和人类协作的共同语言：Spec 既是给人看的文档，也是给 AI 的上下文

## CC-Panes Spec 系统能力

CC-Panes 内置了完整的 Spec 驱动开发支持：

| 能力 | 说明 |
|------|------|
| **Spec 文件管理** | 创建 / 编辑 / 归档 Spec 文档，存储在 `<project>/.ccpanes/specs/` |
| **Todo 双向绑定** | Spec 的 `## Tasks` 段与 Todo 子任务自动同步 |
| **自动日志** | 终端退出时自动执行 `git diff --stat`，将变更追加到 Spec 的 `## Log` 段 |
| **状态流转** | Draft → Active → Archived，同一项目只能有一个 Active Spec |

管理方式：
- **ccpanes MCP 工具**：`create_todo`、`query_todos`、`update_todo`
- **前端 specService**：`create`、`list`、`update`、`getContent`、`syncTasks`、`delete`

## 典型工作流

### Phase 1: 编写 Spec

创建 Spec 文件，按 3 个核心段编写：

1. **Proposal**（提案）
   - 为什么需要这个功能？解决什么问题？
   - 预期效果和验收标准
   - 非功能需求（性能、安全、可用性）

2. **Design**（设计）
   - 技术方案、组件设计、接口定义
   - 影响范围分析（Affected Files）
   - 架构约束和技术选型

3. **Tasks**（任务拆解）
   - 可执行的开发任务 checkbox 列表
   - 按依赖关系排序，标注优先级

创建方式：

```
通过 ccpanes MCP:
  create_todo(title="功能名称", scope="project", scopeRef=<path>, todoType="spec")

通过前端 specService:
  specService.create({ projectPath, title, tasks: ["任务1", "任务2", ...] })
```

### Phase 2: 激活并执行任务

1. 将 Spec 状态改为 **Active**
2. 逐个完成 Tasks 中的子任务
3. AI 在终端工作时，进度自动同步到 Spec 文件
4. 终端退出时，`git diff` 结果自动追加到 `## Log` 段

```
specService.update(specId, { status: "active" })
```

### Phase 3: 归档

所有任务完成后，将 Spec 归档：

```
specService.update(specId, { status: "archived" })
```

归档后文件移至 `specs/archived/` 目录，添加日期前缀。

## Spec 文件模板

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

| 段 | 用途 | 编辑方式 |
|----|------|----------|
| **Proposal** | 变更动机、目标、验收标准 | 手动编写 |
| **Design** | 技术方案、影响文件 | 手动编写 |
| **Tasks** | 任务 checkbox 列表 | 自动同步（通过 Todo 面板编辑） |
| **Log** | 变更日志 | 自动追加（终端退出时） + 手动补充 |

## 最佳实践

1. **先 Spec 后代码** — 不要跳过文档直接写代码，Spec 是防止返工的最佳投资
2. **小粒度迭代** — 一个 Spec 对应一个可交付的功能切片，而非整个系统
3. **Proposal 要回答 Why** — 明确动机和验收标准，避免做完才发现方向错了
4. **Design 要列影响文件** — Affected Files 帮助评估变更范围和风险
5. **Tasks 保持原子化** — 每个任务可独立完成和验证，粒度适中（1-4 小时）
6. **善用自动日志** — Log 段自动记录 git 变更，无需手动维护变更历史

## 快速开始

如果你是第一次使用 OpenSpec：

1. 创建 Spec：`specService.create({ projectPath, title, tasks: [...] })`
2. 填写 Proposal（Why）和 Design（How）
3. 激活 Spec：`specService.update(specId, { status: "active" })`
4. 逐个完成 Tasks，系统自动同步进度和日志
5. 全部完成后归档：`specService.update(specId, { status: "archived" })`
