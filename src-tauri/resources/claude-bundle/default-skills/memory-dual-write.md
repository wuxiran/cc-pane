# 双写记忆

启用本 Skill 后：对值得长期记忆的内容（用户偏好/决策/教训/反馈纠正），调用 `cc-memory` MCP 的 `memory_add` 写入 {{app_name}} 共享池，让 Claude/Codex 跨实例共享。

## 触发时机

- 用户说"记住"、"以后都这样"、"别忘了"
- 用户纠正你（feedback 类）
- 稳定的用户偏好、角色、项目背景
- 值得未来会话参考的设计决定

## 上下文获取（必须）

调用前先用 Bash 读 env：

```bash
echo "$CC_PANES_PROJECT_PATH"
echo "$CC_PANES_WORKSPACE_NAME"
echo "$CC_PANES_CLI_TOOL"
```

这三个值由 {{app_name}} 在启动 CLI 时注入。**全部读不到就不要写记忆**——说明当前不在 {{app_name}} 管控环境，写入会成 stale 数据污染共享池。

## 去重检查（写入前）

先调 `cc-memory.memory_search(query: <title 关键词>, limit: 3)` 看是否已有相同/近似条目：

- 已有且需要更新 → 用 `memory_update`
- 已有且不需要变更 → 跳过
- 没有 → 进入写入

## 写入

```
cc-memory.memory_add(
  title: "<≤200 字摘要>",
  content: "<完整内容>",
  scope: "project" | "workspace" | "global",
  project_path: "<上一步读到的 CC_PANES_PROJECT_PATH 真实值>",  // scope=project/session 必填
  workspace_name: "<上一步读到的 CC_PANES_WORKSPACE_NAME 真实值>",  // scope=workspace/project/session 必填
  category: "decision" | "lesson" | "preference" | "pattern" | "fact" | "plan",
  importance: 1-5,
  tags: ["..."]
)
```

- `scope=global` 时**省略** `project_path` / `workspace_name`（跨项目通用偏好/角色信息）
- **importance ≥ 4 才会在下次会话自动召回**，跨会话有价值的内容打 4-5

## 检索

`cc-memory.memory_search(query, scope, min_importance, limit)` 默认按当前 project 过滤。

## 失败兜底

写入失败不打断主任务，简短告知用户即可。CLI 内置记忆机制照常工作。
