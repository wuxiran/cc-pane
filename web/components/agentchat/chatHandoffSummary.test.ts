import { describe, expect, it } from "vitest";
import type { AgentChatItem } from "@/types/agentChat";
import { buildHandoffSummary, collectEditedFiles, collectHandoffMessages } from "./chatHandoffSummary";

let seq = 0;
const user = (text: string): AgentChatItem => ({ type: "user", id: `u${++seq}`, at: seq, text });
const assistant = (text: string, parentToolCallId?: string): AgentChatItem =>
  ({ type: "assistant", id: `a${++seq}`, at: seq, text, ...(parentToolCallId ? { parentToolCallId } : {}) });
const edit = (path: string, status: "completed" | "failed" = "completed"): AgentChatItem => ({
  type: "tool_call", id: `t${++seq}`, at: seq,
  call: { toolCallId: `c${seq}`, kind: "edit", status, content: [{ type: "diff", path, oldText: "a", newText: "b" }] },
});
const opts = { fromLabel: "Claude Code · Sonnet", toLabel: "Codex" };

describe("handoff summary", () => {
  it("returns null when there is nothing to hand off", () => {
    expect(buildHandoffSummary([{ type: "notice", id: "n", at: 1, text: "x" }], opts)).toBeNull();
  });

  it("keeps every turn in order when under budget, skipping sub-agent output and notices", () => {
    const items = [user("Fix the bug"), assistant("Looking"), edit("src/a.ts"), assistant("Done"),
      assistant("sub-agent noise", "task-1"), { type: "notice", id: "n", at: 1, text: "notice" } as AgentChatItem, user("Thanks")];
    expect(collectHandoffMessages(items).map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    const summary = buildHandoffSummary(items, opts)!;
    expect(summary).toContain("Claude Code · Sonnet");
    expect(summary).toContain("[User]\nFix the bug");
    expect(summary).toContain("[Assistant]\nLooking\n\nDone");
    expect(summary).not.toContain("sub-agent noise");
    expect(summary).not.toContain("omitted");
    expect(summary.indexOf("Fix the bug")).toBeLessThan(summary.indexOf("Thanks"));
    expect(summary).toContain("## Files changed in this conversation\n- src/a.ts");
  });

  it("truncates a single oversized message", () => {
    const summary = buildHandoffSummary([user("x".repeat(5000))], { ...opts, maxMessageChars: 100 })!;
    expect(summary).toContain("…[truncated]");
    expect(summary.length).toBeLessThan(1000);
  });

  it("keeps the first user prompt plus the most recent turns and notes the omission", () => {
    const items: AgentChatItem[] = [user("ORIGINAL TASK")];
    for (let index = 0; index < 40; index += 1) {
      items.push(assistant(`reply ${index} ${"r".repeat(600)}`), user(`follow-up ${index} ${"q".repeat(300)}`));
    }
    const summary = buildHandoffSummary(items, opts)!;
    expect(summary.length).toBeLessThanOrEqual(12_000);
    expect(summary).toContain("ORIGINAL TASK");
    expect(summary).toMatch(/\[… \d+ earlier message\(s\) omitted …\]/);
    expect(summary).toContain("follow-up 39");
    expect(summary).not.toContain("follow-up 0 ");
    expect(summary.indexOf("ORIGINAL TASK")).toBeLessThan(summary.indexOf("omitted"));
    expect(summary.indexOf("omitted")).toBeLessThan(summary.indexOf("follow-up 39"));
  });

  it("lists edited files once, ignoring failed edits and read-only tools", () => {
    const read: AgentChatItem = { type: "tool_call", id: "r", at: 1,
      call: { toolCallId: "r", kind: "read", status: "completed", locations: [{ path: "src/read.ts" }] } };
    const moved: AgentChatItem = { type: "tool_call", id: "m", at: 1,
      call: { toolCallId: "m", kind: "move", status: "completed", locations: [{ path: "src/moved.ts" }] } };
    const items = [edit("src/a.ts"), edit("src/a.ts"), edit("src/failed.ts", "failed"), read, moved, edit("src/b.ts")];
    expect(collectEditedFiles(items)).toEqual(["src/a.ts", "src/moved.ts", "src/b.ts"]);
    const summary = buildHandoffSummary(items, opts)!;
    expect(summary).not.toContain("Earlier conversation");
    expect(summary).toContain("- src/b.ts");
  });
});
