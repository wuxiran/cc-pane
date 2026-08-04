"""派发实现评审给 WSL Codex（经 orchestrator MCP）。

路径用正斜杠书写，避免任何一层 shell/字符串转义把 `\\04` 变成八进制 \x04。
"""
import io
import json

from mcp_call import call_tool

PROJECT_PATH = "D:/04_workspace_rust/cc-book"

prompt = io.open("review-prompt.txt", encoding="utf-8").read()

result = call_tool("launch_task", {
    "projectPath": PROJECT_PATH,
    "cliTool": "codex",
    "runtimeKind": "wsl",
    "title": "Reviewer: 会话认领实现 + 部署风险",
    "prompt": prompt,
})

print(json.dumps(result, ensure_ascii=False)[:1500])
