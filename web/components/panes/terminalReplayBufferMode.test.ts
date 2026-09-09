import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import type { TerminalRecoverySnapshot } from "@/types";
import { stripAlternateBufferSequences } from "./terminalBufferMode";
import { replayAttachedSession } from "./terminalReplay";
import { resyncFromReplaySnapshot } from "./terminalResync";
import { restoreReplayBufferMode } from "./terminalReplayBufferMode";

const terminals: Terminal[] = [];
afterEach(() => {
  terminals.splice(0).forEach(term => term.dispose());
  vi.restoreAllMocks();
});

it("yields while scanning many private modes and cancels before writing to a disposed view", async () => {
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock += 9);
  let live = true;
  const write = vi.fn().mockResolvedValue(undefined);
  const pending = restoreReplayBufferMode({
    checkpoint: null, delta: "\x1b[?25h".repeat(1_000), bufferMode: "alternate",
    endSeq: 1, checkpointEpoch: 1,
  }, { buffer: { active: { type: "normal" } } }, write, () => live);
  live = false;
  await expect(pending).rejects.toThrow("Terminal replay cancelled");
  expect(write).not.toHaveBeenCalled();
});

it("does not finish an empty fullscreen recovery if the view disappears during the mode write", async () => {
  let live = true;
  const sync = vi.fn();
  await expect(replayAttachedSession({
    term: { buffer: { active: { type: "normal" } } },
    sessionId: "disposed-during-mode-write", canWrite: () => live,
    getRecoverySnapshot: async () => ({
      checkpoint: null, delta: "", bufferMode: "alternate", endSeq: 1, checkpointEpoch: 1,
    }),
    writeData: async () => { live = false; }, writeCheckpointData: async () => {},
    syncTrackedBufferType: sync, debugLog: () => {},
  })).rejects.toThrow("Terminal replay cancelled");
  expect(sync).not.toHaveBeenCalled();
});

describe.each(["attach", "resync"] as const)("%s screen recovery with real xterm", (kind) => {
  async function recover(delta: string, bufferMode: "normal" | "alternate", strip = false, photo?: string) {
    const term = new Terminal({ cols: 40, rows: 6, allowProposedApi: true });
    terminals.push(term);
    const write = (data: string) => new Promise<void>(resolve => term.write(data, resolve));
    const snapshot: TerminalRecoverySnapshot = {
      delta, bufferMode, endSeq: 1, checkpointEpoch: 1,
      checkpoint: photo === undefined ? null : {
        snapshotAnsi: photo, bufferMode: "normal", anchorSeq: 0, checkpointEpoch: 1,
        cols: 40, rows: 6, checkpointedAtMs: 1,
      },
    };
    const options = {
      term, sessionId: `mode-${kind}`, reason: "test", getRecoverySnapshot: async () => snapshot,
      writeData: (data: string) => write(strip ? stripAlternateBufferSequences(data) : data),
      writeCheckpointData: write, syncTrackedBufferType: () => {}, debugLog: () => {},
    };
    if (kind === "attach") await replayAttachedSession(options);
    else await resyncFromReplaySnapshot(options);
    return term;
  }

  it("restores fullscreen after the ring evicts DECSET; outer scrollback stays empty", async () => {
    const term = await recover("line\r\n".repeat(80) + "\x1b[Hlatest", "alternate");
    expect(term.buffer.active.type).toBe("alternate");
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("latest");
    term.scrollLines(-100);
    expect(term.buffer.active.baseY).toBe(0);
    expect(term.buffer.active.viewportY).toBe(0);
    expect(term.buffer.normal.length).toBe(term.rows);
  });

  it("restores an empty fullscreen snapshot", async () => {
    expect((await recover("", "alternate")).buffer.active.type).toBe("alternate");
  });

  it.each(["47", "1047", "1049"])("starts in alternate before a retained %s exit", async mode => {
    const term = await recover("old\r\n".repeat(80) + `\x1b[?25;${mode}l` + "shell", "normal");
    expect(term.buffer.active.type).toBe("normal");
    expect(term.buffer.normal.baseY).toBe(0);
    // 1049 restores the saved cursor; 47/1047 intentionally keep the current cursor row.
    expect(term.buffer.normal.cursorY).toBe(mode === "1049" ? 0 : term.rows - 1);
    expect(term.buffer.normal.getLine(term.buffer.normal.cursorY)?.translateToString(true)).toBe("shell");
  });

  it("keeps shell history before a retained fullscreen entry", async () => {
    const term = await recover("shell\r\n".repeat(20) + "\x1b[?1049hfullscreen", "alternate");
    expect(term.buffer.active.type).toBe("alternate");
    expect(term.buffer.normal.baseY).toBeGreaterThan(0);
  });

  it("honors explicit strip mode", async () => {
    const term = await recover("line\r\n".repeat(80), "alternate", true);
    expect(term.buffer.active.type).toBe("normal");
    expect(term.buffer.active.baseY).toBeGreaterThan(0);
  });

  it("uses serialized photo state even when raw backend mode differs", async () => {
    const term = await recover("line\r\n".repeat(20), "alternate", true, "photo\r\n");
    expect(term.buffer.active.type).toBe("normal");
    expect(term.buffer.normal.getLine(0)?.translateToString(true)).toBe("photo");
  });
});
