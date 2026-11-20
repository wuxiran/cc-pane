import { describe, expect, it } from "vitest";
import type { IslandSession } from "@/types/island";
import {
  approvalTones,
  deriveCollapsedView,
  formatElapsed,
  groupSessions,
  optionIndexForKey,
  quickApproveOption,
} from "./islandView";

const session = (id: string, state: IslandSession["state"], since: number): IslandSession => ({
  id, kind: "terminal", name: id, cli: "Claude", state, since, activity: null, approval: null,
});

describe("deriveCollapsedView priority", () => {
  const now = 100_000;

  it("is idle with no sessions", () => {
    expect(deriveCollapsedView(groupSessions([], now), null)).toEqual({ kind: "idle" });
  });

  it("shows the running count with the longest elapsed", () => {
    const view = deriveCollapsedView(groupSessions([session("a", "running", 50_000), session("b", "running", 10_000)], now), null);
    expect(view).toEqual({ kind: "running", count: 2, longestSince: 10_000 });
  });

  it("needs-you beats a done pop and running, and reports the extra running count", () => {
    const done = session("d", "done", 99_000);
    const groups = groupSessions([
      session("r", "running", 1_000),
      session("n2", "needs", 90_000),
      session("n1", "needs", 80_000),
      done,
    ], now);
    expect(deriveCollapsedView(groups, done)).toMatchObject({ kind: "needs", session: { id: "n1" }, count: 2, running: 1 });
  });

  it("a done pop beats running but only while the pop is active", () => {
    const done = session("d", "done", 99_000);
    const groups = groupSessions([session("r", "running", 1_000), done], now);
    expect(deriveCollapsedView(groups, done)).toEqual({ kind: "done", session: done });
    expect(deriveCollapsedView(groups, null).kind).toBe("running");
  });

  it("hides done sessions older than the TTL and orders the newest first", () => {
    const groups = groupSessions([session("old", "done", 0), session("a", "done", 95_000), session("b", "done", 99_000)], 11 * 60_000);
    expect(groups.done.map((s) => s.id)).toEqual(["b", "a"]);
  });
});

describe("formatting and shortcuts", () => {
  it("formats elapsed time as mm:ss or h:mm:ss", () => {
    expect(formatElapsed(768_000)).toBe("12:48");
    expect(formatElapsed(3_723_000)).toBe("1:02:03");
    expect(formatElapsed(-5)).toBe("00:00");
  });

  it("maps number keys to option indexes within range only", () => {
    expect(optionIndexForKey("1", 3)).toBe(0);
    expect(optionIndexForKey("3", 3)).toBe(2);
    expect(optionIndexForKey("4", 3)).toBeNull();
    expect(optionIndexForKey("0", 3)).toBeNull();
    expect(optionIndexForKey("a", 3)).toBeNull();
  });

  it("styles options without reordering them and picks allow_once for the quick approve", () => {
    const options = [
      { optionId: "always", name: "always", kind: "allow_always" },
      { optionId: "once", name: "once", kind: "allow_once" },
      { optionId: "no", name: "no", kind: "reject_once" },
      { optionId: "q", name: "question", kind: "other" },
    ];
    expect(approvalTones(options)).toEqual(["primary", "neutral", "danger", "neutral"]);
    expect(quickApproveOption(options)?.optionId).toBe("once");
    expect(quickApproveOption([{ optionId: "q", name: "q", kind: "other" }])).toBeNull();
  });
});
