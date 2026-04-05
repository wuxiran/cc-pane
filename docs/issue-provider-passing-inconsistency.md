# Issue: Provider 传递不一致

> 状态：待修复
> 优先级：High
> 创建日期：2026-03-11

## 问题描述

不同入口打开 Claude Code 标签时，Provider 环境变量注入行为不一致。部分入口正确传递了 `providerId`，而部分入口缺失或硬编码 `undefined`，导致用户配置的 API Provider 无法生效。

## 各入口 Provider 传递情况

| 入口 | providerId 传递 | 状态 | 关键文件 |
|------|----------------|------|----------|
| 项目右键 → Open Claude Code | `ws.providerId` | 正常 | `ProjectListView.tsx:96` |
| 工作空间级打开 | `ws.providerId` | 正常 | `WorkspaceItem.tsx:136` |
| **自我对话 (SelfChatManager)** | **缺失** | 需修复 | `SelfChatManager.tsx:114-125` |
| **会话列表 Resume** | **硬编码 undefined** | 需修复 | `SessionsView.tsx:122` |
| **Panel "+" 按钮** | **缺失** | 需修复 | `Panel.tsx:185` |
| MCP `launch_task` | 支持 workspace_name 解析 | 正常 | `orchestrator_service.rs:595-608` |
| **REST `handle_launch_task`** | **不做工作空间解析** | 需修复 | `orchestrator_service.rs:1288-1299` |

## 修复方向

### 1. SelfChatManager（前端）

**文件**: `src/components/SelfChatManager.tsx`
**问题**: 发起自我对话时未传递 Provider 信息
**方案**: 支持 Provider 选择或使用当前工作空间的默认 Provider

### 2. SessionsView Resume（前端）

**文件**: `src/components/SessionsView.tsx`
**问题**: Resume 会话时 `providerId` 硬编码为 `undefined`
**方案**: 在会话数据中保存 Provider 信息，Resume 时恢复

### 3. Panel "+" 按钮（前端）

**文件**: `src/components/Panel.tsx`
**问题**: 新建标签页时未传递 Provider
**方案**: 继承当前活动标签的 Provider，或使用工作空间默认 Provider

### 4. REST handle_launch_task（后端）

**文件**: `src-tauri/src/services/orchestrator_service.rs`
**问题**: REST 接口不做工作空间名解析，与 MCP `launch_task` 行为不对齐
**方案**: 对齐 MCP 的工作空间解析逻辑，支持通过 `workspace_name` 查找关联 Provider

## 实现建议

修复顺序建议：Panel "+" → SessionsView Resume → SelfChatManager → REST handle_launch_task

理由：
- Panel "+" 和 SessionsView 是用户最常用的入口，影响面最大
- SelfChatManager 使用频率次之
- REST 接口主要用于外部集成，优先级稍低
