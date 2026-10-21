import { describe, expect, it } from "vitest";
import { chatRunHistoryEntries, historyEventDetails } from "./chatRunHistoryEntries";
import type { AcpRunEvent } from "@/types/agentRuntime";

function chunk(seq: number, text: string, type = "agent_message_chunk"): AcpRunEvent {
  return { seq, at: seq, kind: "update", payload: { update: { sessionUpdate: type, content: { type: "text", text } } } };
}

describe("durable run rendering", () => {
  it("merges contiguous streamed chunks while preserving reasoning and event order", () => {
    const entries = chatRunHistoryEntries([chunk(1, "Hello "), chunk(2, "world"), chunk(3, "Reason", "agent_thought_chunk"),
      { seq: 4, at: 4, kind: "permission_request", payload: { requestKey: "historical" } }, chunk(5, "After")]);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toMatchObject({ kind: "assistant", text: "Hello world" });
    expect(entries[1]).toMatchObject({ kind: "thought", text: "Reason" });
    expect(entries[2].kind).toBe("event");
    expect(entries[3]).toMatchObject({ kind: "assistant", text: "After" });
  });
  it("renders user text and attachment names without embedding image bytes", () => {
    const entries = chatRunHistoryEntries([{ seq: 1, at: 1, kind: "user_prompt", payload: { prompt: [
      { type: "text", text: "Inspect" }, { type: "image", data: "private-base64", mimeType: "image/png" },
      { type: "resource_link", name: "readme.md", uri: "file:///repo/readme.md" },
    ] } }]);
    expect(entries[0]).toMatchObject({ kind: "user", text: "Inspect", attachments: ["image", "readme.md"] });
    expect(JSON.stringify(entries)).not.toContain("private-base64");
  });
  it("retains unknown events and safely bounds expanded diagnostic output", () => {
    expect(chatRunHistoryEntries([{ seq: 1, at: 1, kind: "future-event", payload: {} }])[0].kind).toBe("event");
    expect(historyEventDetails({ type: "image", data: "a".repeat(300) })).not.toContain("a".repeat(300));
    expect(historyEventDetails({ output: "x".repeat(100000) }).length).toBeLessThan(65600);
  });
});
