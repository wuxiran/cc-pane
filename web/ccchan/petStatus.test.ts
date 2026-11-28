import { describe, expect, it } from "vitest";
import type { TerminalStatusInfo, TerminalStatusType } from "@/types";
import {
  aggregatePetStatus,
  botPetStatus,
  buildSessionEntries,
  IDLE_BOT_STATE,
  nextReadySet,
  pickClickTarget,
  resolvePetAnimation,
  terminalPetStatus,
} from "./petStatus";
import type { PetMeta, SessionDirectoryEntry } from "./types";

function info(sessionId: string, status: TerminalStatusType, updatedAt = 0): TerminalStatusInfo {
  return { sessionId, status, lastOutputAt: 0, updatedAt };
}

describe("petStatus", () => {
  it("maps terminal statuses and skips exited sessions", () => {
    expect(terminalPetStatus("waitingInput", false)).toBe("needsInput");
    expect(terminalPetStatus("error", false)).toBe("blocked");
    expect(terminalPetStatus("thinking", false)).toBe("running");
    expect(terminalPetStatus("toolRunning", true)).toBe("running");
    expect(terminalPetStatus("idle", false)).toBe("idle");
    expect(terminalPetStatus("idle", true)).toBe("ready");
    expect(terminalPetStatus("exited", true)).toBeNull();
  });

  it("aggregates by priority needsInput > blocked > ready > running > idle", () => {
    expect(aggregatePetStatus([])).toBe("idle");
    expect(aggregatePetStatus(["running", "idle"])).toBe("running");
    expect(aggregatePetStatus(["running", "ready"])).toBe("ready");
    expect(aggregatePetStatus(["ready", "blocked", "running"])).toBe("blocked");
    expect(aggregatePetStatus(["blocked", "needsInput", "ready"])).toBe("needsInput");
  });

  it("maps the bot conversation: replying = running, error = blocked, approval = needsInput", () => {
    expect(botPetStatus(IDLE_BOT_STATE)).toBe("idle");
    expect(botPetStatus({ ...IDLE_BOT_STATE, phase: "generating" })).toBe("running");
    expect(botPetStatus({ ...IDLE_BOT_STATE, phase: "ready", error: true })).toBe("blocked");
    expect(botPetStatus({ ...IDLE_BOT_STATE, phase: "failed" })).toBe("blocked");
    expect(botPetStatus({ phase: "generating", pendingRequests: 1, error: false })).toBe("needsInput");
  });

  it("keeps ready until the session is viewed", () => {
    const running = new Map<string, TerminalStatusType>([["a", "thinking"], ["b", "idle"]]);
    const finished = new Map<string, TerminalStatusType>([["a", "idle"], ["b", "idle"]]);
    let ready = nextReadySet(running, finished, new Set(), new Set());
    expect([...ready]).toEqual(["a"]);
    // 状态不变的后续刷新：仍然 ready。
    ready = nextReadySet(finished, finished, ready, new Set());
    expect([...ready]).toEqual(["a"]);
    // 用户看过了：清掉。
    ready = nextReadySet(finished, finished, ready, new Set(["a"]));
    expect(ready.size).toBe(0);
  });

  it("does not mark ready when the user is already looking, and drops vanished sessions", () => {
    const running = new Map<string, TerminalStatusType>([["a", "thinking"]]);
    const finished = new Map<string, TerminalStatusType>([["a", "idle"]]);
    expect(nextReadySet(running, finished, new Set(), new Set(["a"])).size).toBe(0);
    expect(nextReadySet(finished, new Map(), new Set(["a"]), new Set()).size).toBe(0);
    const working = new Map<string, TerminalStatusType>([["a", "thinking"]]);
    expect(nextReadySet(finished, working, new Set(["a"]), new Set()).size).toBe(0);
  });

  it("builds a session list with tab titles, most urgent first", () => {
    const directory = new Map<string, SessionDirectoryEntry>([
      ["s-wait", { sessionId: "s-wait", title: "修复登录", viewed: false }],
    ]);
    const entries = buildSessionEntries(
      [info("s-run-1234567890", "thinking", 5), info("s-wait", "waitingInput", 1), info("s-done", "idle", 9)],
      new Set(["s-done"]),
      directory,
    );
    expect(entries.map((e) => [e.title, e.status])).toEqual([
      ["修复登录", "needsInput"],
      ["s-done", "ready"],
      ["s-run-12", "running"],
    ]);
  });

  it("click jumps to the most urgent session, otherwise asks the bot", () => {
    const urgent = buildSessionEntries([info("x", "waitingInput")], new Set(), new Map());
    expect(pickClickTarget(urgent, "idle")).toEqual({ kind: "session", sessionId: "x" });
    const running = buildSessionEntries([info("y", "thinking")], new Set(), new Map());
    expect(pickClickTarget(running, "idle")).toEqual({ kind: "ask" });
    expect(pickClickTarget([], "idle")).toEqual({ kind: "ask" });
    const ready = buildSessionEntries([info("z", "idle")], new Set(["z"]), new Map());
    expect(pickClickTarget(ready, "needsInput")).toEqual({ kind: "ask" });
  });

  it("resolves animations for codex keys and legacy keys", () => {
    const pet = {
      id: "p",
      displayName: "p",
      description: "",
      spritesheetUrl: "",
      atlas: { cellW: 192, cellH: 208, cols: 8, rows: 9 },
      animations: {
        idle: { row: 0, frames: 6, fps: 4 },
        working: { row: 7, frames: 6, fps: 10 },
        happy: { row: 3, frames: 4, fps: 8 },
        blocked: { row: 5, frames: 8, fps: 6 },
      },
    } satisfies PetMeta;
    expect(resolvePetAnimation(pet, "running").row).toBe(7);
    expect(resolvePetAnimation(pet, "ready").row).toBe(3);
    expect(resolvePetAnimation(pet, "blocked").row).toBe(5);
    expect(resolvePetAnimation(pet, "needsInput").row).toBe(0);
  });
});
