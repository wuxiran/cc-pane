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

  // 上次启动失败（WSL 缺原生 CLI）：即使还带着预发 resumeId 也不算 resumed，
  // 否则重启会拿一个从未存在的会话 id 去 --resume，报告也会把它记成回归。
  it("带 launchFailure 时是 failed，压过 resumeId 与可接管会话", () => {
    const launchFailure = { reason: "native-cli-missing", at: 1 };
    expect(
      resolveRestoreMode({ cliTool: "claude", resumeId: "issued-1", launchFailure }),
    ).toBe("failed");
    expect(
      resolveRestoreMode({ cliTool: "claude", hasRestorableSession: true, launchFailure }),
    ).toBe("failed");
  });

  it("纯 shell 即使带 launchFailure 也是 shell", () => {
    expect(
      resolveRestoreMode({ cliTool: "none", launchFailure: { reason: "x", at: 1 } }),
    ).toBe("shell");
  });
});
