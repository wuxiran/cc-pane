# 阶段 7：通知中心

## 目标

实现集中式通知管理和转发系统，支持微信、邮件等渠道推送。

## 状态

📋 待实现

## 背景说明

后续要支持将 Claude Code 的状态变化（完成、报错、等待输入等）推送到微信、邮件等外部渠道。Rust 后端需要有一个集中管理通知转发的模块。

## 核心功能

### 1. 事件采集

监控终端状态变化：运行中 / 等待输入 / 停止 / 报错 / 完成。

### 2. 通知分发

根据配置将事件转发到不同渠道。

### 3. 渠道管理

支持多种通知渠道：

- **本地系统通知** — Tauri notification
- **企业微信 Webhook** — 企业微信群机器人
- **微信推送** — Server酱 / PushPlus 等第三方服务
- **邮件** — SMTP 发送
- **自定义 Webhook** — 用户自行配置的 HTTP 回调

## 任务清单

- [ ] 定义通知事件模型 (AlertEvent)
- [ ] 实现事件采集器（从终端输出检测状态）
- [ ] 实现通知渠道 Trait (NotificationChannel)
- [ ] 实现企业微信 Webhook 渠道
- [ ] 实现邮件 SMTP 渠道
- [ ] 实现自定义 Webhook 渠道
- [ ] 实现通知分发器 (Dispatcher)
- [ ] 实现通知配置 (TOML)
- [ ] GUI: 通知配置面板
- [ ] GUI: 通知历史记录

## 配置示例

```toml
[notifications]
enabled = true

[[notifications.channels]]
type = "wechat_work"
name = "企业微信"
webhook_url = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"
events = ["stopped", "error", "crashed"]

[[notifications.channels]]
type = "email"
name = "邮件告警"
smtp_server = "smtp.gmail.com"
to = ["admin@example.com"]
events = ["crashed", "error"]
```

## 文件位置

- 后端: `src-tauri/src/services/notification_service.rs`（待创建）

## 下一步

完成阶段 7 后，进入 [阶段 8：文件浏览与 Markdown 预览](./08-document-management.md)
