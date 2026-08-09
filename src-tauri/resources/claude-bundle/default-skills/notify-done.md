---
name: ccpanes-notify-done
description: "在回复收尾时通过 trigger_notification 推送富摘要通知（桌面 + IM）。Use when finishing a substantial turn: a long task completed, an error needs the user, or a decision is required. Skip for trivial Q&A."
---

# 收尾富摘要通知

CC-Panes 会在每轮回复结束时自动发一条硬编码的基础通知（"✅ Completed"）。
本 skill 让你在**值得通知**的回合把它升级成带摘要的富通知——你发了富通知，
基础兜底自动跳过，用户只收到一条。

## 何时通知（三者其一才调，否则不要调）

- **耗时任务完成**：多文件改动落地、构建/测试跑完、长工具链结束
- **需要用户介入的错误**：你无法自行解决、必须用户处理
- **需要用户拍板的决策**：方案分叉、破坏性操作确认

琐碎问答、单文件小改、纯阅读回答 → **不要调**（IM 轰炸比漏通知更伤）。

## 前置检查

环境变量 `CC_PANES_PTY_SESSION_ID` 不存在 → 不在 {{app_name}} 管控下，
跳过整个 skill，不要报错也不要提及。

## 怎么调（作为回复的最后一个动作）

调 `{{mcp_server_name}}.trigger_notification`：

| 参数 | 值 |
|------|-----|
| `kind` | **固定 `"turn_end"`** ——这是与兜底通知互斥的契约，写别的值会导致用户收到两条 |
| `sessionId` | `$CC_PANES_PTY_SESSION_ID` 的值（必填，缺了互斥失效） |
| `title` | ≤20 字结果，如 "✅ 登录模块重构完成" / "❌ 迁移失败需人工介入" |
| `body` | ≤200 字摘要：做了什么 / 改了哪些文件 / 测试结果 / 下一步建议 |
| `requiresInput` | 需要用户决策时设 `true`，并配 `inputPlaceholder` |

## 注意

- 返回 `{skipped: true}` 是正常现象（通知开关关闭/窗口聚焦等），**不要重试、不要向用户报告**。
- 一轮只调一次，放在所有实质工作完成之后。
- 通知是给用户的，用用户的语言写 title/body（中文用户用中文）。
