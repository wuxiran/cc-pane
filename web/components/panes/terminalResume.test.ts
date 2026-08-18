import { beforeEach, describe, it, expect, vi } from "vitest";
import { pickCreateSessionResumeId, replayColdRestoreOutput } from "./terminalResume";
import { stripSgrBackgroundColors } from "./terminalBufferMode";
import { useResumeBindingStore } from "@/stores/useResumeBindingStore";
import { sessionRestoreService } from "@/services/sessionRestoreService";

beforeEach(() => {
  useResumeBindingStore.setState({ bindings: {} });
});

describe("pickCreateSessionResumeId", () => {
  it("returns the explicit resumeId from props", () => {
    expect(pickCreateSessionResumeId({ resumeId: "sess-123" })).toBe("sess-123");
  });

  it("never falls back to launch history when resumeId is absent", () => {
    // 回归断言：缺 resumeId 时必须按"新建"处理（undefined），
    // 不得按目录从 launch history 续接上次会话（commit 65c9a2f 的 bug）。
    expect(pickCreateSessionResumeId({ resumeId: undefined })).toBeUndefined();
    expect(pickCreateSessionResumeId({})).toBeUndefined();
  });

  // ResumeBindingStore 是权威镜像：快照 props.resumeId 是落盘时机决定的副本，
  // store 按 savedSessionId 精确命中时永远不旧于它（docs/86 必修4）。
  it("prefers the ResumeBindingStore binding for the exact saved session", () => {
    useResumeBindingStore.getState().recordBinding("pty-1", "resume-fresh", "issued");
    expect(
      pickCreateSessionResumeId({ resumeId: "resume-stale", savedSessionId: "pty-1" }),
    ).toBe("resume-fresh");
  });

  it("falls back to props.resumeId when the store has no binding", () => {
    expect(
      pickCreateSessionResumeId({ resumeId: "resume-snapshot", savedSessionId: "pty-miss" }),
    ).toBe("resume-snapshot");
  });

  it("ignores the store entirely without a savedSessionId (no directory hijack)", () => {
    useResumeBindingStore.getState().recordBinding("pty-other", "resume-other", "issued");
    expect(pickCreateSessionResumeId({ resumeId: undefined })).toBeUndefined();
  });
});

// 冷恢复是第四个绕过 renderTerminalData 的写入口（photo / resync / deferred-restore
// 之外）。`.output` 落盘的是带 ANSI 的原始行，直接 writeln 会把 CLI 的显式背景
// 写回 cell——壁纸透明模式下与 photo 管道同一个洞。
describe("replayColdRestoreOutput", () => {
  const collectReplay = async (
    lines: string[],
    render?: (data: string) => string,
  ): Promise<string[]> => {
    vi.spyOn(sessionRestoreService, "loadOutput").mockResolvedValue(lines);
    const written: string[] = [];
    await replayColdRestoreOutput(
      { writeln: (line) => written.push(line) },
      "pty-cold",
      () => {},
      () => {},
      render,
    );
    return written;
  };

  it("strips SGR backgrounds from replayed lines when a renderer is supplied", async () => {
    const written = await collectReplay(
      ["\x1b[41m FAIL \x1b[49m detail", "plain"],
      stripSgrBackgroundColors,
    );
    expect(written).toContain("\x1b[49m FAIL \x1b[49m detail");
    expect(written).toContain("plain");
    expect(written.some((line) => line.includes("\x1b[41m"))).toBe(false);
  });

  it("defaults to identity so opaque mode replays lines untouched", async () => {
    const written = await collectReplay(["\x1b[41m FAIL \x1b[49m detail"]);
    expect(written).toContain("\x1b[41m FAIL \x1b[49m detail");
  });
});
