import { describe, expect, it } from "vitest";

import { inferCliTool, resolveRestoreMode } from "@/lib/terminalRestoreMode";

describe("inferCliTool", () => {
  it("显式 cliTool 优先，忽略 hints", () => {
    expect(inferCliTool("codex", true, "abc")).toBe("codex");
  });

  it("缺省时任一 hint 为真即推断 claude", () => {
    expect(inferCliTool(undefined, false, undefined, "resume-id")).toBe("claude");
  });

  it("缺省且无 hint 时是 none", () => {
    expect(inferCliTool(undefined, undefined, false)).toBe("none");
  });
});

describe("resolveRestoreMode", () => {
  it("纯 shell 没有 resume 语义", () => {
    expect(resolveRestoreMode({ cliTool: "none", resumeId: "abc" })).toBe("shell");
  });

  it("有真身可接管时是 resumed", () => {
    expect(
      resolveRestoreMode({ cliTool: "claude", hasRestorableSession: true }),
    ).toBe("resumed");
  });

  it("带真实 resumeId 是 resumed", () => {
    expect(resolveRestoreMode({ cliTool: "codex", resumeId: "sess-1" })).toBe("resumed");
  });

  // "new" 是「显式开新会话」的哨兵值，不是一个可恢复的会话 id。
  it('resumeId 为 "new" 算 fresh', () => {
    expect(resolveRestoreMode({ cliTool: "claude", resumeId: "new" })).toBe("fresh");
  });

  it("什么都没有是 fresh", () => {
    expect(resolveRestoreMode({ cliTool: "claude" })).toBe("fresh");
  });
});
