import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  isColdReplayNotResumed,
  pickCreateSessionResumeId,
  replayColdRestoreOutput,
} from "./terminalResume";
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
    notResumed?: boolean,
  ): Promise<string[]> => {
    vi.spyOn(sessionRestoreService, "loadOutput").mockResolvedValue(lines);
    const written: string[] = [];
    await replayColdRestoreOutput(
      { writeln: (line) => written.push(line) },
      "pty-cold",
      () => {},
      () => {},
      render,
      notResumed,
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

  // 不续接原对话时重放的只是旧画面：不能再写 "Session restored" 让人误以为接上了。
  it("labels the replay as stale output when the conversation will not be resumed", async () => {
    const written = await collectReplay(["No conversation found with session ID: dead"], undefined, true);
    expect(written[0]).not.toContain("Session restored");
    expect(written[0]).toContain("以下是上次会话的旧输出");
  });

  it("keeps the restored header when the conversation is resumed", async () => {
    const written = await collectReplay(["hello"]);
    expect(written[0]).toContain("Session restored");
  });
});

describe("isColdReplayNotResumed", () => {
  it("is true for an agent CLI tab without any resume id", () => {
    expect(isColdReplayNotResumed({ cliTool: "claude", savedSessionId: "pty-1" })).toBe(true);
    expect(isColdReplayNotResumed({ launchClaude: true })).toBe(true);
  });

  it("is false when a resume id will be used", () => {
    expect(isColdReplayNotResumed({ cliTool: "claude", resumeId: "r-1" })).toBe(false);
    useResumeBindingStore.getState().recordBinding("pty-2", "r-2", "issued");
    expect(isColdReplayNotResumed({ cliTool: "codex", savedSessionId: "pty-2" })).toBe(false);
  });

  it("is false for plain shell tabs", () => {
    expect(isColdReplayNotResumed({ cliTool: "none" })).toBe(false);
    expect(isColdReplayNotResumed({})).toBe(false);
  });
});
