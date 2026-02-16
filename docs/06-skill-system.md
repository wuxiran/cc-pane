# 阶段 6：Skill 系统（待设计）

## 目标

从应用内管理和执行 Claude Code 任务。

## 状态

📋 待设计

## 背景说明

原设计是一套 Markdown frontmatter 格式的 Skill 文件系统（类似 Claude Code 自带的 slash commands）。但 Claude Code 本身已有 skill/slash command 机制，需要重新思考 CC-Panes 的 Skill 系统定位，避免功能重复。

## 可能的方向

### 1. 任务模板

预定义常用的 Claude Code 任务描述，一键发送到终端。

### 2. 工作流编排

多步骤自动化工作流，例如：先 review → 再 fix → 最后 commit。

### 3. Prompt 库

项目级/全局级 prompt 模板管理，快速复用常用指令。

### 4. 与 Claude Code 原生 Skill 集成

读取/管理 `.claude/commands/` 目录中的自定义命令，提供可视化编辑界面。

## 任务清单（初步）

- [ ] 确定 Skill 系统的定位和边界
- [ ] 设计 Skill 数据模型
- [ ] 实现 Skill 存储和加载
- [ ] GUI: Skill 管理面板
- [ ] GUI: Skill 执行（向终端发送命令）

> **注意**: 此阶段需要进一步讨论确认方向。

## 下一步

完成阶段 6 后，进入 [阶段 7：通知中心](./07-alert-system.md)
