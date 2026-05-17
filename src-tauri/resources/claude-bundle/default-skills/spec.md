---
name: ccpanes-spec
description: Guide a spec-driven development workflow — requirements → design → tasks → implementation — using the `spec-workflow` MCP. Use when the user says "走 spec 流程"、"先写规格"、"requirements → design → tasks"、"spec workflow"、"start a new spec"、"按规范驱动开发". **Only useful if the `spec-workflow` MCP is installed**; skip otherwise and tell the user to install it first.
---

# Spec 工作流

参数: $ARGUMENTS

## 前置检查

`spec-workflow` 是另一个 MCP server，用户可能没装。第一次调用 `spec-workflow.*` 工具失败时，告诉用户：在 {{app_name}} 中安装 / 启用 `spec-workflow` MCP 后再使用本 skill。

## 流程

### 1. 加载工作流指南

**必须首先**调用 `spec-workflow.spec-workflow-guide` —— 这是获取完整步骤说明的入口。

### 2. 按 4 阶段执行

| Phase | 输出 | 关键动作 |
|---|---|---|
| **1. Requirements** | `specs/<name>/requirements.md` | 讨论需求 → 提交审批 → 等用户确认 |
| **2. Design** | `specs/<name>/design.md` | 基于需求设计 → 提交审批 |
| **3. Tasks** | `specs/<name>/tasks.md` | 拆解任务 → 提交审批 |
| **4. Implementation** | 代码 | 逐任务实现，每步 `spec-workflow.log-implementation` 记录；可选 `{{mcp_server_name}}.launch_task` 并行分派 |

**每阶段需用户审批**才能进入下一步。

### 3. 进度查询

`spec-workflow.spec-status(specName)`。

## 子命令

| 形式 | 行为 |
|---|---|
| 无参 | 加载 guide → 问需求 → 从 Phase 1 开始 |
| `status <name>` | `spec-status` |
| `resume <name>` | 查进度 → 从中断处续 |
| `steering` | `spec-workflow.steering-guide` → 引导创建 product.md / tech.md / structure.md |

## 示例

```
/ccpanes:spec
/ccpanes:spec status my-feature
/ccpanes:spec resume my-feature
/ccpanes:spec steering
```
