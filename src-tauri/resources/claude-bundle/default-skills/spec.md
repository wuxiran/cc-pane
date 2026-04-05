# Spec 工作流

引导使用 spec-workflow MCP 进行需求驱动开发：从需求文档到任务拆解再到实现。

参数: $ARGUMENTS

---

## MCP 工具

### spec-workflow MCP 服务器

| 工具 | 用途 |
|------|------|
| `spec-workflow-guide` | 加载 Spec 工作流指南（**必须首先调用**） |
| `steering-guide` | 加载项目引导文档创建指南 |
| `spec-status` | 查看 Spec 进度 |
| `approvals` | 管理审批请求 |
| `log-implementation` | 记录实现日志 |

### {{mcp_server_name}} MCP 服务器

| 工具 | 用途 |
|------|------|
| `launch_task` | 启动实例执行任务 |
| `list_projects` | 列出项目 |

---

## 流程

### 1. 加载工作流指南

**必须首先**调用 `spec-workflow.spec-workflow-guide` 获取完整工作流说明。

### 2. 根据阶段执行

Spec 工作流分 4 个阶段，按顺序执行：

#### Phase 1: Requirements（需求文档）
- 与用户讨论需求
- 创建 `specs/<spec-name>/requirements.md`
- 提交审批 → 等待用户确认

#### Phase 2: Design（设计文档）
- 基于需求设计技术方案
- 创建 `specs/<spec-name>/design.md`
- 提交审批 → 等待用户确认

#### Phase 3: Tasks（任务拆解）
- 将设计拆解为可执行任务
- 创建 `specs/<spec-name>/tasks.md`
- 提交审批 → 等待用户确认

#### Phase 4: Implementation（实现）
- 按任务列表逐个实现
- 使用 `log-implementation` 记录每个任务的实现详情
- 可选：使用 `{{mcp_server_name}}.launch_task` 并行分派任务

### 3. 查看进度

调用 `spec-workflow.spec-status`（参数: `specName`）查看整体完成度。

---

## 子命令

### 无参数 — 开始新 Spec

1. 加载工作流指南
2. 询问用户需求
3. 从 Phase 1 开始

### `status <spec-name>` — 查看进度

调用 `spec-workflow.spec-status`。

### `resume <spec-name>` — 继续未完成的 Spec

1. 查看进度，确定当前阶段
2. 从中断处继续

### `steering` — 创建项目引导文档

调用 `spec-workflow.steering-guide` 获取指南，引导创建 product.md / tech.md / structure.md。

---

## 示例

```
/ccpanes:spec                          # 开始新的 Spec 工作流
/ccpanes:spec status my-feature        # 查看 my-feature 的进度
/ccpanes:spec resume my-feature        # 继续未完成的 Spec
/ccpanes:spec steering                 # 创建项目引导文档
```

---

## 注意

- 每个阶段的文档需要用户审批后才能进入下一阶段
- 使用 spec-workflow 的 `approvals` 工具管理审批流程
- 实现阶段可结合 `{{mcp_server_name}}.launch_task` 并行执行任务
