import { describe, expect, it } from "vitest";
import { botChatId, botIdOfChat, emptyBot } from "./bot";

describe("bot chat ids", () => {
  it("round-trips bot ids through chat ids", () => {
    expect(botChatId("abc")).toBe("bot-abc");
    expect(botIdOfChat("bot-abc")).toBe("abc");
  });

  it("rejects non-bot chat ids", () => {
    expect(botIdOfChat("tab-123")).toBeNull();
    expect(botIdOfChat("bot-")).toBeNull();
    expect(botIdOfChat(undefined)).toBeNull();
  });

  it("creates an empty draft living in its home folder", () => {
    const draft = emptyBot("claude");
    expect(draft).toMatchObject({ id: "", engineId: "claude", cwd: null, autoApproveKinds: [] });
  });
});
