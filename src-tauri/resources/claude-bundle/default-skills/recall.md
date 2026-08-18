---
name: ccpanes-recall
description: Recall past plans for the current project or workspace from CC-Panes history. 触发词：上次、之前、我们做过、how did we、recall plan。缺少 CC_PANES_PROJECT_PATH 环境变量时跳过。
---

# 召回

触发词：用户问"上次/之前/我们做过/how did we/what did we do/recall plan"等。

## 上下文

```bash
echo "$CC_PANES_PROJECT_PATH"
echo "$CC_PANES_WORKSPACE_NAME"
```

两个都读不到 → 跳过本 skill。

## 召回

调用 `{{mcp_server_name}}.search_plans`：

```
{{mcp_server_name}}.search_plans(
  projectPath:    "$CC_PANES_PROJECT_PATH",
  workspaceName:  "$CC_PANES_WORKSPACE_NAME",   # 可空
  keyword:        "<从用户提问中提取的关键词,简短>",
  limit:          3,
  sessionId:      "$CLAUDE_SESSION_ID"           # 用于热度去重
)
```

返回的每条 plan 取 `intent + followups + tags` 即可，**不要**把 plan 全文展开。

## 输出

```markdown
找到 N 条相关 plan:
1. <intent>（tags: ...）
   - followups: <followups>
2. ...
```

## 失败兜底

- 没有匹配条目 → 告诉用户没找到，让 ta 描述更细的关键词
- 调用失败 → 简短告知，不阻塞主任务

## 何时不用本 skill

- 用户问的是当前会话内的事（直接答即可，不需要召回）
- 用户想要 plan 全文 → 让 ta 在 `<project>/.ccpanes/plans/` 或 `<workspace>/.ccpanes/plans/` 直接看归档文件
