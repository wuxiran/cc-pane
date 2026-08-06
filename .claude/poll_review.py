"""轮询评审会话，直到出现真正的完成标记或会话终止。

完成标记用 `IMPL-REVIEW-DONE 必修=<数字>`：prompt 里出现的是字面量
`必修=N`（字母 N），PTY 回显不会误命中。

停滞判定不能只看 status（WSL Codex 有"活着但没提交"的坑），
这里额外看 lastOutputAt 是否长时间不前进。
"""
import json
import re
import sys
import time

from mcp_call import call_tool

SESSION_ID = "703d8f71-651d-42a4-8a33-a139df1a6f6f"
DONE = re.compile(r"IMPL-REVIEW-DONE\s+必修=\d+")
STALL_LIMIT = 6  # 连续 6 轮（约 3 分钟）无新输出才判停滞


def text_of(result):
    try:
        return result["result"]["content"][0]["text"]
    except (KeyError, IndexError, TypeError):
        return ""


last_output_at = 0
stalled = 0

for i in range(1, 81):
    out = text_of(call_tool("get_session_output", {"sessionId": SESSION_ID, "lines": 700}))
    if DONE.search(out):
        print(f"REVIEW COMPLETE at poll {i}")
        sys.exit(0)

    raw_status = text_of(call_tool("get_session_status", {"sessionId": SESSION_ID}))
    if '"exited"' in raw_status:
        print(f"EXITED at poll {i}")
        sys.exit(0)

    try:
        current = json.loads(raw_status).get("lastOutputAt", 0)
    except json.JSONDecodeError:
        current = 0
    if current and current == last_output_at:
        stalled += 1
        if stalled >= STALL_LIMIT:
            print(f"STALLED at poll {i}: 无新输出约 3 分钟")
            sys.exit(0)
    else:
        stalled = 0
        last_output_at = current

    time.sleep(30)

print("TIMEOUT after ~40min")
