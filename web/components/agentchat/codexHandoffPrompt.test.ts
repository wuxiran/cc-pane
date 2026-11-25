import { describe, expect, it } from "vitest";
import type { AgentChatItem } from "@/types/agentChat";
import { CODEX_HANDOFF_MAX_BYTES, isHandoffPromptValid, lastAssistantReply, quoteForHandoff, utf8Bytes } from "./codexHandoffPrompt";

describe("quoteForHandoff", () => {
  it("quotes each line and leaves an empty line for the user's instruction", () => {
    expect(quoteForHandoff("  first\r\n\r\nsecond  ")).toEqual({ text: "> first\n>\n> second\n\n", truncated: false });
  });

  it("returns nothing for blank selections", () => {
    expect(quoteForHandoff("  \n ")).toEqual({ text: "", truncated: false });
  });

  it("truncates oversized UTF-8 selections and still leaves room for instructions", () => {
    const quoted = quoteForHandoff("中".repeat(5000));
    expect(quoted.truncated).toBe(true);
    expect(quoted.text.endsWith("> …\n\n")).toBe(true);
    expect(utf8Bytes(quoted.text)).toBeLessThanOrEqual(CODEX_HANDOFF_MAX_BYTES - 1024);
    expect(isHandoffPromptValid(`${quoted.text}Review this.`)).toBe(true);
  });

  it("accounts for existing text when prepending a quote", () => {
    const existing = "x".repeat(6000);
    const quoted = quoteForHandoff("y".repeat(3000), utf8Bytes(existing));
    expect(quoted.truncated).toBe(true);
    expect(isHandoffPromptValid(quoted.text + existing)).toBe(true);
  });
});

describe("lastAssistantReply", () => {
  it("joins the last turn's top-level assistant text and skips sub-agent output", () => {
    const items: AgentChatItem[] = [
      { type: "user", id: "u1", at: 1, text: "q1" },
      { type: "assistant", id: "a1", at: 2, text: "old" },
      { type: "user", id: "u2", at: 3, text: "q2" },
      { type: "assistant", id: "a2", at: 4, text: "part one" },
      { type: "assistant", id: "sub", at: 5, text: "child", parentToolCallId: "t" },
      { type: "assistant", id: "a3", at: 6, text: "part two" },
      { type: "notice", id: "n", at: 7, text: "note" },
    ];
    expect(lastAssistantReply(items)).toBe("part one\n\npart two");
    expect(lastAssistantReply([{ type: "user", id: "u", at: 1, text: "q" }])).toBe("");
  });
});
