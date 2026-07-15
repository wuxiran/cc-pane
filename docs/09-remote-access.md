# 阶段 9：远程访问（已实现，本文为早期设计记录）

> **本文已过时**：远程访问已通过 `cc-panes-web`（Axum Web 服务，复用桌面 React 前端 + REST/WS）与 `cc-panes-mobile`（Flutter Android 客户端）落地，多端通过持久终端 daemon 共享同一批 PTY 会话（见 [`17-persistent-terminal-daemon.md`](17-persistent-terminal-daemon.md)）。
> 用户使用手册见 [`guide/16-web-and-mobile.md`](guide/16-web-and-mobile.md)。以下内容保留为当年的方案调研记录。

## 目标

支持通过移动端设备远程连接和监控 CC-Panes。

## 状态

✅ 已实现（cc-panes-web + cc-panes-mobile，实际实现即下文「方案 A：Web 服务」方向）

## 背景说明

用户希望在手机上远程查看 Claude Code 的运行状态、接收通知、简单操控（如确认/取消）。这不是完整的远程桌面方案，而是轻量级的状态监控和简单交互。

## 可能的实现方案

### 方案 A：内置 HTTP API + Web UI

- 在应用内启动轻量 HTTP 服务器（如 axum）
- 提供 REST API 查询实例状态、项目列表等
- 提供一个简单的移动端友好 Web 页面，方便手机浏览器访问
- 优点：自包含，不依赖第三方服务
- 缺点：需要处理内网穿透、HTTPS 等问题

### 方案 B：推送通知 + 简单回调

- 通过微信/Telegram Bot 推送 Claude Code 状态变更通知
- 支持简单的回复操作（确认/取消/重试）
- 优点：无需暴露端口，移动端体验好
- 缺点：依赖第三方平台，功能受限

### 方案 C：WebSocket 实时连接

- 实时推送状态变更事件
- 支持双向通信，可执行更复杂的远程操作
- 优点：实时性好，交互能力强
- 缺点：实现复杂度较高

## 任务清单（初步）

- [ ] 确定远程访问方案
- [ ] 设计 API 接口
- [ ] 实现安全认证机制（Token 认证、IP 限制等）
- [ ] 实现移动端 UI
- [ ] 安全性考虑（HTTPS、Token 认证、IP 白名单）

> **注意**：此阶段需要进一步讨论确认方案，上述任务清单仅为初步规划。

## 下一步

确定方案后，进入详细设计和实现。参见 [阶段 10：测试](./10-testing-release.md)。
