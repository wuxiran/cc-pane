---
name: ccpanes-workspace-migrate
description: Guide the user through {{app_name}}'s built-in "Migrate Workspace" UI flow — moving a workspace from one local directory to another, or from local to WSL. Use when the user says "迁移工作空间"、"换到 WSL"、"搬目录"、"move my workspace"、"migrate to WSL"、"换位置". This skill does NOT execute migration directly (it's a UI-driven feature); it tells the user where to click and what to verify.
---

# 工作空间迁移

参数: $ARGUMENTS

## 适用范围

| 支持 | 不支持（v1） |
|---|---|
| local → local | local → ssh |
| local → wsl | 删除原 Windows 副本 |
|  | 自动双向同步 |

## 固定四步流程

预检 → 复制 → 校验 → 切换。**校验失败前不切换入口**。

## UI 操作（{{app_name}} 左侧工作空间树）

1. 右键目标 workspace → `迁移工作空间...`
2. 选目标环境 + 目标根目录
3. 跑预检 → 预览结果
4. 确认后执行迁移
5. 失败 → 仅回滚 workspace 配置，不删目标副本

## 迁移规则

- workspace 根目录整体复制
- `workspace.path` 外的本地项目 → 放到 `externals/...`
- 默认排除：`node_modules` / `target` / `.venv` / `.next` / `dist` / `build` / `.turbo` / `.cache` / `__pycache__`
- 源目录**不删**

## 结果

- 迁到 WSL：默认环境切到 `wsl`，记录新 WSL 根目录；Windows 路径保留供过渡。
- 迁到本机新目录：workspace 本机路径更新。

## 建议

- 先迁小 workspace 验证流程
- 大 workspace 前确认目标目录为空
- 迁完后用 workspace 右键打开 Claude/Codex 验证路径
