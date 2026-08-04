"""通过 orchestrator 的 MCP HTTP 端点调用工具。

ctl 的端点发现是文件式的，而 mcp-orchestrator.json 已被删除；
orchestrator 服务本身仍在 47821 存活，这里直接走 MCP 协议，
不去重写 app 拥有的配置文件。
"""
import json
import sys
import urllib.request

URL = "http://127.0.0.1:47821/mcp?token=5de08792b7e83f565432378429160c0f"
TOKEN = "5de08792b7e83f565432378429160c0f"


def post(payload, session_id=None):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(URL, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json, text/event-stream")
    req.add_header("Authorization", f"Bearer {TOKEN}")
    if session_id:
        req.add_header("Mcp-Session-Id", session_id)
    with urllib.request.urlopen(req, timeout=180) as resp:
        raw = resp.read().decode("utf-8", "replace")
        return resp.headers.get("Mcp-Session-Id"), raw


def parse_sse(raw):
    """端点以 SSE 帧返回 JSON-RPC，取最后一个 data: 行。"""
    result = None
    for line in raw.splitlines():
        if line.startswith("data: "):
            chunk = line[6:].strip()
            if chunk:
                try:
                    result = json.loads(chunk)
                except json.JSONDecodeError:
                    pass
    return result


def call_tool(name, arguments):
    sid, raw = post({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "review-launcher", "version": "1"},
        },
    })
    if not sid:
        raise SystemExit(f"initialize 未返回 session id: {raw[:200]}")

    post({"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)

    _, raw = post({
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    }, sid)
    return parse_sse(raw)


if __name__ == "__main__":
    tool = sys.argv[1]
    args = json.load(open(sys.argv[2], encoding="utf-8"))
    print(json.dumps(call_tool(tool, args), ensure_ascii=False)[:2000])
