import { describe, expect, it } from "vitest";
import {
  compactRelativeTime,
  engineSequence,
  normalizeEpochMs,
  PROJECT_AVATAR_TOKENS,
  projectAvatarToken,
  projectInitials,
  resolveSessionTitle,
  stableHash,
} from "./sessionCardModel";

const base = { title: "cc-pane (Claude)", titleRenamed: false, sessionTitle: null, firstPrompt: null };

describe("resolveSessionTitle", () => {
  it("prefers the distilled title over the first prompt", () => {
    expect(resolveSessionTitle({ ...base, sessionTitle: "起草授权委托书", firstPrompt: "帮我做个委托书" }))
      .toEqual({ text: "起草授权委托书", kind: "sessionTitle" });
  });

  it("falls back to the first user prompt, flattened to one line", () => {
    expect(resolveSessionTitle({ ...base, firstPrompt: "  修复\n恢复日志\t的中文化  " }))
      .toEqual({ text: "修复 恢复日志 的中文化", kind: "firstPrompt" });
  });

  it("falls back to the tab title when neither exists (blank strings count as missing)", () => {
    expect(resolveSessionTitle({ ...base, sessionTitle: "  ", firstPrompt: "\n" }))
      .toEqual({ text: "cc-pane (Claude)", kind: "tabTitle" });
  });

  it("a manual tab rename beats everything", () => {
    expect(resolveSessionTitle({ ...base, title: "我的命名", titleRenamed: true, sessionTitle: "自动" }))
      .toEqual({ text: "我的命名", kind: "renamed" });
  });
});

describe("projectInitials", () => {
  it.each([
    ["sub2api-product", "S2"],
    ["cc-pane", "CP"],
    ["cc_panes core", "CP"],
    ["WeChatBot", "WC"],
    ["vms", "VM"],
    ["x", "X"],
    ["工作空间", "工"],
    ["  ", "?"],
  ])("%s → %s", (name, expected) => {
    expect(projectInitials(name)).toBe(expected);
  });
});

describe("projectAvatarToken", () => {
  it("is stable for the same name and ignores case / surrounding spaces", () => {
    const token = projectAvatarToken("sub2api-product");
    expect(projectAvatarToken("sub2api-product")).toBe(token);
    expect(projectAvatarToken("  SUB2API-Product ")).toBe(token);
    expect(PROJECT_AVATAR_TOKENS).toContain(token);
  });

  it("uses a fixed hash (FNV-1a) so colors survive reloads", () => {
    expect(stableHash("")).toBe(0x811c9dc5);
    expect(stableHash("a")).toBe(0xe40c292c);
  });

  it("never picks gray and spreads different projects across the palette", () => {
    const names = ["cc-pane", "sub2api-product", "vms-workspace", "echo-studio", "freight", "cc-book", "wechat", "notes"];
    const tokens = new Set(names.map(projectAvatarToken));
    expect(tokens.size).toBeGreaterThan(3);
    expect([...tokens].some((token) => token.includes("gray"))).toBe(false);
  });
});

describe("engineSequence", () => {
  it("dedupes keeping the most recent occurrence on the right", () => {
    expect(engineSequence(["claude", "codex", "claude"])).toEqual(["codex", "claude"]);
    expect(engineSequence([null, " ", undefined, "codex"])).toEqual(["codex"]);
  });
});

describe("time helpers", () => {
  it("normalizes second timestamps to milliseconds", () => {
    expect(normalizeEpochMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(normalizeEpochMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(normalizeEpochMs(0)).toBeNull();
    expect(normalizeEpochMs(undefined)).toBeNull();
  });

  it("formats compact relative time", () => {
    const now = Date.UTC(2026, 10, 23, 12);
    expect(compactRelativeTime(now - 10_000, now, "刚刚")).toBe("刚刚");
    expect(compactRelativeTime(now - 5 * 60_000, now, "刚刚")).toBe("5m");
    expect(compactRelativeTime(now - 3 * 3_600_000, now, "刚刚")).toBe("3h");
    expect(compactRelativeTime(now - 2 * 86_400_000, now, "刚刚")).toBe("2d");
    expect(compactRelativeTime(now + 60_000, now, "刚刚")).toBe("刚刚");
  });
});
