#!/usr/bin/env python3
"""Local NDJSON ACP acceptance fixture; never connects to an Agent provider."""
import http.server
import json
import os
from pathlib import Path
import sys


def record(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value), encoding="utf-8")
    temporary.replace(path)


def server(state):
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"owned agent runtime fixture")

        def log_message(self, *_args):
            pass

    with http.server.HTTPServer(("127.0.0.1", 0), Handler) as httpd:
        record(state, {"kind": "server", "pid": os.getpid(),
                       "port": httpd.server_port, "script": str(Path(__file__).resolve())})
        print("Owned fixture background server is ready", flush=True)
        httpd.serve_forever()


class Adapter:
    def __init__(self, mode, repo, state):
        self.mode, self.repo, self.state = mode, Path(repo), Path(state)
        self.session = "fixture-" + self.state.name
        self.prompt_id = None
        self.client_id = None
        record(str(self.state) + ".adapter.json", {
            "kind": "adapter", "pid": os.getpid(), "script": str(Path(__file__).resolve())})

    def send(self, message):
        print(json.dumps({"jsonrpc": "2.0", **message}), flush=True)

    def reply(self, request_id, result):
        self.send({"id": request_id, "result": result})

    def update(self, update):
        self.send({"method": "session/update", "params": {
            "sessionId": self.session, "update": update}})

    def client_request(self, request_id, method, params):
        self.client_id = request_id
        self.send({"id": request_id, "method": method, "params": {
            "sessionId": self.session, **params}})

    def complete(self, message):
        self.update({"sessionUpdate": "tool_call_update", "toolCallId": "fixture-write",
                     "status": "completed"})
        self.update({"sessionUpdate": "agent_message_chunk", "content": {
            "type": "text", "text": message}})
        self.reply(self.prompt_id, {"stopReason": "end_turn"})
        self.prompt_id = None

    def prompt(self, message):
        self.prompt_id = message["id"]
        record(str(self.state) + ".prompt.json", {"received": True})
        if self.mode == "hold":
            self.update({"sessionUpdate": "agent_message_chunk", "content": {
                "type": "text", "text": "Fixture is holding this turn until stopped."}})
            return
        self.update({"sessionUpdate": "tool_call", "toolCallId": "fixture-write",
                     "title": "Write owned fixture.txt", "kind": "edit", "status": "in_progress"})
        content = "background turn edit\n" if self.mode == "background" else "after agent edit\n"
        self.client_request("fixture-write-request", "fs/write_text_file", {
            "path": str(self.repo / "fixture.txt"), "content": content})

    def client_response(self, message):
        if "error" in message:
            self.send({"id": self.prompt_id, "error": message["error"]})
        elif self.mode == "background" and self.client_id == "fixture-write-request":
            self.update({"sessionUpdate": "tool_call", "toolCallId": "fixture-server",
                         "title": "Start owned background server", "kind": "execute",
                         "status": "in_progress"})
            self.client_request("fixture-server-request", "terminal/create", {
                "command": sys.executable,
                "args": [str(Path(__file__).resolve()), "--server", str(self.state) + ".server.json"],
                "cwd": str(self.repo), "outputByteLimit": 4096})
        else:
            self.complete("Owned fixture finished; background server remains active."
                          if self.mode == "background" else "Owned fixture edit finished.")

    def receive(self, message):
        method = message.get("method")
        if method == "initialize":
            self.reply(message["id"], {"protocolVersion": 1, "agentCapabilities": {},
                                      "agentInfo": {"name": "owned-runtime-fixture", "version": "1"}})
        elif method == "session/new":
            self.reply(message["id"], {"sessionId": self.session})
        elif method == "session/prompt":
            self.prompt(message)
        elif method == "session/cancel" and self.prompt_id is not None:
            self.reply(self.prompt_id, {"stopReason": "cancelled"})
            self.prompt_id = None
        elif method is None and message.get("id") == self.client_id:
            self.client_response(message)
        elif method is not None and "id" in message:
            self.send({"id": message["id"], "error": {"code": -32601, "message": "Fixture method unsupported"}})


if __name__ == "__main__":
    if sys.argv[1] == "--server":
        server(sys.argv[2])
    else:
        adapter = Adapter(*sys.argv[2:5])
        for line in sys.stdin:
            if line.strip():
                adapter.receive(json.loads(line))
