---
name: ccpanes-memory-dual-write
description: Mirror long-term memory into the CC-Panes shared pool so Claude and Codex share one memory. 触发词：记住、别忘了、以后都这样、用户纠正你或确认稳定偏好时，以及 remember that / don't forget。三个 CC_PANES_* 环境变量全缺失时必须跳过——那说明 CLI 不在 CC-Panes 管控下，写入会污染共享池。
---

# 双写记忆

## 触发时机

- 用户说"记住"/"以后都"/"别忘了"
- 用户纠正你（feedback 类）
- 稳定偏好、角色、项目背景
- 值得未来会话参考的决定

## 上下文获取（必须）

```bash
echo "$CC_PANES_PROJECT_PATH"
echo "$CC_PANES_WORKSPACE_NAME"
echo "$CC_PANES_CLI_TOOL"
```

**三个值全部读不到 → 不要写**（说明当前不在 {{app_name}} 管控环境，会污染共享池）。

## 去重（写入前）

`{{mcp_server_name}}.memory_search(query: <title 关键词>, limit: 3)`：

- 有近似条目 → `memory_update`
- 已有相同 → 跳过
- 没有 → 写入

## 写入

```
{{mcp_server_name}}.memory_add(
  title:        "<≤200 字摘要>",
  content:      "<完整内容>",
  scope:        "project" | "workspace" | "global",
  project_path: <CC_PANES_PROJECT_PATH>,     # scope=project/session 必填
  workspace_name: <CC_PANES_WORKSPACE_NAME>, # scope=workspace/project/session 必填
  category:     "decision" | "lesson" | "preference" | "pattern" | "fact" | "plan",
  importance:   1-5,
  tags:         [...]
)
```

- `scope=global` 时省略 `project_path` / `workspace_name`
- **importance ≥ 4** 才会下次会话自动召回

## 检索

`{{mcp_server_name}}.memory_search(query, scope, min_importance, limit)` 默认按当前 project 过滤。

## 失败兜底

写入失败不打断主任务；简短告知用户即可。CLI 内置记忆继续工作。
