import { describe, expect, it } from "vitest";
import type { AcpToolCall, AgentChatItem } from "@/types/agentChat";
import { collectNetChanges } from "./ChatChangesPanel";

const edit = (id: string, before: string | null, after: string, status: AcpToolCall["status"] = "completed"): AgentChatItem => ({
  type: "tool_call", id, at: 1,
  call: { toolCallId: id, status, content: [{ type: "diff", path: "file.ts", oldText: before, newText: after }] },
});

describe("collectNetChanges", () => {
  it("counts only completed edits and keeps failed/in-flight output out of the net result", () => {
    expect(collectNetChanges([
      edit("pending", "invented", "pending", "pending"),
      edit("first", "original", "first"),
      edit("failed", "first", "failure", "failed"),
      edit("running", "first", "unfinished", "in_progress"),
      edit("last", "first", "final"),
    ])).toEqual([{ path: "file.ts", firstOld: "original", lastNew: "final" }]);
  });

  it("retains new-file diffs without inventing a previous file", () => {
    expect(collectNetChanges([edit("create", null, "created")])).toEqual([
      { path: "file.ts", firstOld: "", lastNew: "created" },
    ]);
    expect(collectNetChanges([edit("empty", null, "")])).toHaveLength(1);
  });

  it("does not aggregate malformed diffs or tool titles as file changes", () => {
    expect(collectNetChanges([
      { type: "assistant", id: "text", at: 1, text: "Edited file.ts" },
      { type: "tool_call", id: "tool", at: 1, call: { toolCallId: "tool", status: "completed", content: [
        { type: "diff", path: "file.ts", newText: "missing original" },
        { type: "diff", path: "file.ts", oldText: "missing result" },
      ] } },
      edit("unchanged", "same", "same"),
    ])).toEqual([]);
  });
});
