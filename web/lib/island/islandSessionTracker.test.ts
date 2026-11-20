import { describe, expect, it } from "vitest";
import { DONE_TTL_MS, IslandSessionTracker, type IslandSource } from "./islandSessionTracker";

const source = (patch: Partial<IslandSource> = {}): IslandSource => ({
  id: "s1",
  kind: "terminal",
  name: "bot-fix",
  cli: "Claude",
  activity: "running",
  detail: null,
  approval: null,
  ...patch,
});

describe("IslandSessionTracker", () => {
  it("keeps the running start time across updates and reports it as since", () => {
    const tracker = new IslandSessionTracker();
    tracker.update([source()], 1_000);
    const [session] = tracker.update([source({ detail: "编辑 a.rs" })], 5_000);
    expect(session).toMatchObject({ state: "running", since: 1_000, activity: "编辑 a.rs" });
  });

  it("records a finish with the summary when an active session turns idle", () => {
    const tracker = new IslandSessionTracker();
    tracker.update([source({ detail: "cargo test" })], 1_000);
    const sessions = tracker.update([source({ activity: "idle", summary: "PR #112" })], 9_000);
    expect(sessions).toEqual([
      expect.objectContaining({ id: "s1", state: "done", since: 9_000, activity: "PR #112" }),
    ]);
  });

  it("falls back to the last seen tool summary when no completion summary exists", () => {
    const tracker = new IslandSessionTracker();
    tracker.update([source({ detail: "cargo test" })], 1_000);
    const [done] = tracker.update([source({ activity: "idle" })], 2_000);
    expect(done.activity).toBe("cargo test");
  });

  it("does not invent a finish for a session that was idle all along", () => {
    const tracker = new IslandSessionTracker();
    tracker.update([source({ activity: "idle" })], 1_000);
    expect(tracker.update([source({ activity: "idle" })], 2_000)).toEqual([]);
  });

  it("treats a session vanishing mid-run as finished, using its last known name", () => {
    const tracker = new IslandSessionTracker();
    tracker.update([source({ name: "issue64" })], 1_000);
    expect(tracker.update([], 3_000)).toEqual([
      expect.objectContaining({ id: "s1", name: "issue64", state: "done" }),
    ]);
  });

  it("tracks waiting since separately and carries the approval only while needed", () => {
    const tracker = new IslandSessionTracker();
    const approval = { requestKey: "k", title: "npm run dev", detail: null, options: [], responding: false, error: null, queued: 0 };
    tracker.update([source()], 1_000);
    const [needs] = tracker.update([source({ activity: "needs", approval })], 4_000);
    expect(needs).toMatchObject({ state: "needs", since: 4_000, approval });
    const [running] = tracker.update([source({ approval })], 6_000);
    expect(running).toMatchObject({ state: "running", since: 1_000, approval: null });
  });

  it("drops finished records after the TTL and on dismiss", () => {
    const tracker = new IslandSessionTracker();
    tracker.update([source(), source({ id: "s2" })], 0);
    tracker.update([source({ activity: "idle" }), source({ id: "s2", activity: "idle" })], 1_000);
    tracker.dismiss("s2");
    expect(tracker.update([source({ activity: "idle" }), source({ id: "s2", activity: "idle" })], 2_000))
      .toEqual([expect.objectContaining({ id: "s1" })]);
    expect(tracker.update([source({ activity: "idle" })], 1_000 + DONE_TTL_MS + 1)).toEqual([]);
  });

  it("clears a finish record once the session runs again", () => {
    const tracker = new IslandSessionTracker();
    tracker.update([source()], 0);
    tracker.update([source({ activity: "idle" })], 1_000);
    const sessions = tracker.update([source()], 2_000);
    expect(sessions).toEqual([expect.objectContaining({ state: "running", since: 2_000 })]);
  });
});
