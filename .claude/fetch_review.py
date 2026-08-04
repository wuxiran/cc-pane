"""抓取评审输出的三段结论并落盘，避免终端截断。"""
import io

from mcp_call import call_tool

SESSION_ID = "703d8f71-651d-42a4-8a33-a139df1a6f6f"


def text_of(result):
    try:
        return result["result"]["content"][0]["text"]
    except (KeyError, IndexError, TypeError):
        return ""


out = text_of(call_tool("get_session_output", {"sessionId": SESSION_ID, "lines": 1200}))
io.open("review-output.txt", "w", encoding="utf-8").write(out)

marker = out.rfind("✅")
print(out[marker - 200:] if marker > 0 else out[-8000:])
