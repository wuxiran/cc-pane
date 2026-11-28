import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminalService } from "@/services/terminalService";
import { useTerminalStatusStore } from "@/stores/useTerminalStatusStore";
import { resolveLiveSavedSession } from "@/components/panes/terminalViewHelpers";
import type { TerminalAdoptionSnapshot, TerminalStatusInfo } from "@/types";
import {
  ADOPTION_SNAPSHOT_REUSE_WINDOW_MS,
  clearAdoptionSnapshotForTest,
  liveFromAdoptionSnapshot,
  recordAdoptionSnapshot,
} from "./adoptionSnapshotReuse";

const CAPTURED = 1_000_000;

function status(sessionId: string, value: TerminalStatusInfo["status"]): TerminalStatusInfo {
  return { sessionId, status: value, lastOutputAt: 1, updatedAt: 1 } as TerminalStatusInfo;
}

function snapshot(overrides: Partial<TerminalAdoptionSnapshot> = {}): TerminalAdoptionSnapshot {
  return {
    claimsSupported: true,
    daemonGeneration: 7,
    ownerInstanceId: "app",
    capturedAtMs: CAPTURED,
    complete: true,
    sessions: [status("live-1", "idle"), status("dead-1", "exited")],
    claims: {},
    provenance: {},
    ...overrides,
  };
}

function setGeneration(daemonGeneration: number | undefined) {
  vi.spyOn(terminalService, "getCachedDaemonClientInfo").mockReturnValue({
    mode: "daemon",
    daemonGeneration,
  });
}

function setStatuses(statuses: TerminalStatusInfo[]) {
  useTerminalStatusStore.setState({
    statusMap: new Map(statuses.map((s) => [s.sessionId, s])),
  });
}

describe("liveFromAdoptionSnapshot", () => {
  beforeEach(() => {
    clearAdoptionSnapshotForTest();
    setStatuses([]);
    setGeneration(7);
  });
  afterEach(() => vi.restoreAllMocks());

  it("answers from a fresh, same-generation snapshot", () => {
    recordAdoptionSnapshot(snapshot());
    expect(liveFromAdoptionSnapshot("live-1", CAPTURED + 1000)).toBe(true);
    expect(liveFromAdoptionSnapshot("dead-1", CAPTURED + 1000)).toBe(false);
    expect(liveFromAdoptionSnapshot("unknown", CAPTURED + 1000)).toBe(false);
  });

  it("falls back (null) without a snapshot or with an incomplete one", () => {
    expect(liveFromAdoptionSnapshot("live-1", CAPTURED)).toBeNull();
    recordAdoptionSnapshot(snapshot({ complete: false }));
    expect(liveFromAdoptionSnapshot("live-1", CAPTURED)).toBeNull();
    recordAdoptionSnapshot(snapshot({ daemonGeneration: undefined }));
    expect(liveFromAdoptionSnapshot("live-1", CAPTURED)).toBeNull();
  });

  // 竞态：daemon 在快照之后重启（世代变了）→ 快照里的会话全部失效，不能复用。
  it("falls back when the daemon generation changed after the snapshot", () => {
    recordAdoptionSnapshot(snapshot());
    setGeneration(8);
    expect(liveFromAdoptionSnapshot("live-1", CAPTURED + 1000)).toBeNull();
    setGeneration(undefined);
    expect(liveFromAdoptionSnapshot("live-1", CAPTURED + 1000)).toBeNull();
  });

  // 竞态：快照太旧（期间的退出事件可能丢了）或时钟倒退 → 回退单独查询。
  it("falls back when the snapshot is stale or from the future", () => {
    recordAdoptionSnapshot(snapshot());
    expect(liveFromAdoptionSnapshot("live-1", CAPTURED + ADOPTION_SNAPSHOT_REUSE_WINDOW_MS + 1)).toBeNull();
    expect(liveFromAdoptionSnapshot("live-1", CAPTURED - 1)).toBeNull();
  });

  // 竞态：会话在快照之后退出 → 状态缓存里的 exited 是更新的证据，判死。
  it("treats a session that exited after the snapshot as gone", () => {
    recordAdoptionSnapshot(snapshot());
    setStatuses([status("live-1", "exited")]);
    expect(liveFromAdoptionSnapshot("live-1", CAPTURED + 1000)).toBe(false);
  });

  it("never revives a session the snapshot saw as not live", () => {
    recordAdoptionSnapshot(snapshot());
    setStatuses([status("dead-1", "idle")]);
    expect(liveFromAdoptionSnapshot("dead-1", CAPTURED + 1000)).toBe(false);
  });
});

describe("resolveLiveSavedSession", () => {
  beforeEach(() => {
    clearAdoptionSnapshotForTest();
    setStatuses([]);
    setGeneration(7);
  });
  afterEach(() => vi.restoreAllMocks());

  it("uses the adoption snapshot when it is reusable", () => {
    vi.spyOn(Date, "now").mockReturnValue(CAPTURED + 500);
    recordAdoptionSnapshot(snapshot());
    expect(resolveLiveSavedSession("live-1")).toEqual({
      liveSessionId: "live-1",
      source: "adoption-snapshot",
    });
  });

  it("falls back to the status cache when the snapshot cannot be trusted", () => {
    vi.spyOn(Date, "now").mockReturnValue(CAPTURED + 500);
    recordAdoptionSnapshot(snapshot());
    setGeneration(9);
    setStatuses([status("live-1", "idle")]);
    expect(resolveLiveSavedSession("live-1")).toEqual({
      liveSessionId: "live-1",
      source: "status-cache",
    });
    expect(resolveLiveSavedSession(undefined)).toEqual({
      liveSessionId: null,
      source: "status-cache",
    });
  });
});
