# 阶段 6：Skill 系统（已完成）

## 目标

从应用内管理和执行 Claude Code 任务。

## 状态

✅ 已完成

## 实现说明

最终采用了 **与 Claude Code 原生 Skill 集成** 的方向，直接读取和管理项目 `.claude/commands/` 目录中的自定义命令（Markdown 文件），提供可视化的列表、编辑和执行功能。

同时实现了 **Hooks 系统**，支持项目级工作流定义，用于自动化任务编排。

## 任务清单

- [x] 确定 Skill 系统的定位和边界（与 Claude Code `.claude/commands/` 集成）
- [x] 实现 Skill 读取和加载（list/get/save/delete/copy）
- [x] 实现 Hooks 工作流系统
- [x] GUI: Skill 管理面板
- [x] GUI: Skill 执行（向终端发送命令）

## 实际文件位置

**后端:**

- `src-tauri/src/commands/skill_commands.rs` — Skill Tauri 命令接口
- `src-tauri/src/services/skill_service.rs` — Skill 业务逻辑
- `src-tauri/src/commands/hooks_commands.rs` — Hooks Tauri 命令接口
- `src-tauri/src/services/hooks_service.rs` — Hooks 业务逻辑

**前端:**

- `src/services/skillService.ts` — Skill 前端服务层
- `src/services/hooksService.ts` — Hooks 前端服务层

## 下一步

完成阶段 6 后，进入 [阶段 7：通知中心](./07-alert-system.md)
