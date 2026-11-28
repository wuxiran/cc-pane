import { describe, expect, it } from "vitest";
import {
  buildOrbEntries,
  inputAge,
  localExpandedLayout,
  orbCenter,
  orbClickTarget,
  orbPanelHeight,
  orbPanelRect,
  orbRingGradient,
  orbRingSegments,
  orderOrbEntries,
  ORB_PANEL_GAP,
  ORB_PANEL_MAX_HEIGHT,
  ORB_PANEL_WIDTH,
  ORB_TIMINGS,
  ORB_WINDOW,
  type OrbEntry,
} from "./orbModel";
import type { PetStatus } from "./petStatus";

function entry(sessionId: string, status: PetStatus, lastInputAt: number | null, extra: Partial<OrbEntry> = {}): OrbEntry {
  return { sessionId, title: sessionId, status, updatedAt: 0, lastInputAt, active: false, ...extra };
}

const ids = (list: readonly OrbEntry[]) => list.map((item) => item.sessionId);

describe("orbModel ordering", () => {
  it("puts the most recent keyboard input first by default", () => {
    const ordered = orderOrbEntries(
      [entry("old", "needsInput", 1_000), entry("new", "idle", 9_000), entry("mid", "running", 5_000)],
      { sort: "recent", pinned: [] },
    );
    expect(ids(ordered.all)).toEqual(["new", "mid", "old"]);
  });

  it("breaks ties by status weight and sinks sessions never typed into", () => {
    const ordered = orderOrbEntries(
      [entry("never-idle", "idle", null), entry("never-wait", "needsInput", null), entry("tie-run", "running", 10), entry("tie-err", "blocked", 10)],
      { sort: "recent", pinned: [] },
    );
    expect(ids(ordered.all)).toEqual(["tie-err", "tie-run", "never-wait", "never-idle"]);
  });

  it("ignores switching: active / updatedAt changes do not reorder the auto list", () => {
    const base = [entry("a", "idle", 300), entry("b", "idle", 200), entry("c", "idle", 100)];
    const before = orderOrbEntries(base, { sort: "recent", pinned: [] });
    // 切到 c：c 成为当前（离开列表），其余 updatedAt 变化——顺序不受影响。
    const switched = base.map((item) => ({ ...item, updatedAt: item.sessionId === "a" ? 99 : 1, active: item.sessionId === "c" }));
    const after = orderOrbEntries(switched, { sort: "recent", pinned: [] });
    expect(ids(after.all)).toEqual(["a", "b"]);
    expect(ids(before.all).filter((id) => id !== "c")).toEqual(ids(after.all));
    expect(after.current?.sessionId).toBe("c");
  });

  it("supports the needs-me order and keeps pins first in pin order", () => {
    const list = [entry("run", "running", 900), entry("wait", "needsInput", 100), entry("err", "blocked", 500), entry("idle", "idle", 999)];
    expect(ids(orderOrbEntries(list, { sort: "attention", pinned: [] }).all)).toEqual(["wait", "err", "run", "idle"]);
    const pinned = orderOrbEntries(list, { sort: "attention", pinned: ["idle", "gone", "run"] });
    expect(ids(pinned.pinned)).toEqual(["idle", "run"]);
    expect(ids(pinned.all)).toEqual(["idle", "run", "wait", "err"]);
  });

  it("merges lastInputAt and active from the main window directory", () => {
    const entries = buildOrbEntries(
      [{ sessionId: "s1", title: "T", status: "idle", updatedAt: 0 }, { sessionId: "s2", title: "U", status: "idle", updatedAt: 0 }],
      new Map([["s1", { sessionId: "s1", title: "T", viewed: true, lastInputAt: 42, active: true }]]),
    );
    expect(entries[0]).toMatchObject({ lastInputAt: 42, active: true });
    expect(entries[1]).toMatchObject({ lastInputAt: null, active: false });
  });
});

describe("orbModel ring and center", () => {
  it("splits the ring into one gapped segment per session, current last", () => {
    const ordered = orderOrbEntries(
      [entry("cur", "idle", 1, { active: true }), entry("w", "needsInput", 5), entry("e", "blocked", 3)],
      { sort: "recent", pinned: [] },
    );
    const segments = orbRingSegments(ordered, 8);
    expect(segments.map((segment) => segment.status)).toEqual(["needsInput", "blocked", "idle"]);
    expect(segments[0]).toEqual({ status: "needsInput", startDeg: 4, endDeg: 116 });
    expect(segments[2].endDeg).toBe(356);
    const gradient = orbRingGradient(segments);
    expect(gradient).toContain("var(--app-status-warning) 4deg 116deg");
    expect(gradient).toContain("var(--app-status-danger)");
    expect(gradient.startsWith("conic-gradient(transparent 0deg 4deg")).toBe(true);
  });

  it("keeps a single session ring nearly full and an empty ring neutral", () => {
    const one = orbRingSegments(orderOrbEntries([entry("x", "running", 1)], { sort: "recent", pinned: [] }), 7);
    expect(one).toEqual([{ status: "running", startDeg: 3.5, endDeg: 356.5 }]);
    expect(orbRingSegments(orderOrbEntries([], { sort: "recent", pinned: [] }))).toEqual([]);
    expect(orbRingGradient([])).toContain("var(--app-text-tertiary)");
  });

  it("counts waiting + errors in the center and picks the tone", () => {
    expect(orbCenter([entry("a", "needsInput", null), entry("b", "blocked", null), entry("c", "running", null)]))
      .toEqual({ count: 2, tone: "warning", waiting: 1, calm: false });
    expect(orbCenter([entry("b", "blocked", null)])).toMatchObject({ count: 1, tone: "danger" });
    expect(orbCenter([entry("i", "idle", null)])).toEqual({ count: 0, tone: null, waiting: 0, calm: true });
    expect(orbCenter([]).calm).toBe(true);
  });
});

describe("orbModel click and layout", () => {
  const ordered = orderOrbEntries([entry("a", "idle", 2), entry("b", "idle", 1)], { sort: "recent", pinned: [] });

  it("clicks to the first entry when closed and the highlighted one when open", () => {
    expect(orbClickTarget(ordered, false, 1)?.sessionId).toBe("a");
    expect(orbClickTarget(ordered, true, 1)?.sessionId).toBe("b");
    expect(orbClickTarget(ordered, true, 9)?.sessionId).toBe("a");
    expect(orbClickTarget(orderOrbEntries([], { sort: "recent", pinned: [] }), false, 0)).toBeNull();
  });

  it("caps the requested panel height", () => {
    const many = orderOrbEntries(Array.from({ length: 40 }, (_, i) => entry(`s${i}`, "idle", i)), { sort: "recent", pinned: [] });
    expect(orbPanelHeight(many)).toBe(ORB_PANEL_MAX_HEIGHT);
    expect(orbPanelHeight(ordered)).toBeLessThan(ORB_PANEL_MAX_HEIGHT);
  });

  it("places the panel below / above the orb cell following the backend direction", () => {
    const down = orbPanelRect(localExpandedLayout(200));
    expect(down).toEqual({ x: 0, y: ORB_WINDOW + ORB_PANEL_GAP, width: ORB_PANEL_WIDTH, height: 200 });
    const up = orbPanelRect({
      expanded: true, width: ORB_PANEL_WIDTH, height: ORB_WINDOW + ORB_PANEL_GAP + 200,
      orbX: ORB_PANEL_WIDTH - ORB_WINDOW, orbY: 200 + ORB_PANEL_GAP, alignRight: true, openUp: true,
    });
    expect(up).toEqual({ x: 0, y: 0, width: ORB_PANEL_WIDTH, height: 200 });
  });

  it("formats input age buckets", () => {
    expect(inputAge(null, 0)).toEqual({ key: "never" });
    expect(inputAge(1_000, 3_000)).toEqual({ key: "justNow" });
    expect(inputAge(0, 42_000)).toEqual({ key: "seconds", count: 42 });
    expect(inputAge(0, 5 * 60_000)).toEqual({ key: "minutes", count: 5 });
    expect(inputAge(0, 2 * 3_600_000)).toEqual({ key: "hours", count: 2 });
  });

  it("keeps the interaction timings in one place", () => {
    expect(ORB_TIMINGS).toEqual({ openDelayMs: 200, dwellSwitchMs: 650, closeDelayMs: 280 });
  });
});
