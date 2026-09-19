import { describe, expect, it } from "vitest";
import type { Tab, TaskBinding } from "@/types";
import { completedTaskTabId, hasRetainedExitedOutput } from "./completedTaskAutoClose";

const binding: TaskBinding = {
  id: "task", title: "Task", role: "worker", projectPath: "/repo", cliTool: "codex",
  sessionId: "pty", status: "completed", progress: 100, completionSummary: "Saved result",
  sortOrder: 0, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  metadata: { ui: { autoCloseCompletedSessionId: "pty", autoCloseCompletedTabId: "tab" } },
};
const tab: Tab = { id: "tab", title: "Worker", projectId: "p", projectPath: "/repo", contentType: "terminal", sessionId: "pty" };

describe("completed task auto close safety", () => {
  it("only selects the explicitly opted-in tab after the grace period", () => {
    expect(completedTaskTabId(binding, [tab, { ...tab, id: "other", sessionId: "other-pty" }], true, 30_000)).toBe("tab");
    expect(completedTaskTabId(binding, [tab], true, 29_999)).toBeNull();
  });
  it("is disabled by default and requires per-task opt-in plus saved summary", () => {
    expect(completedTaskTabId(binding, [tab], false, 60_000)).toBeNull();
    for (const patch of [{ metadata: {} }, { completionSummary: " " }, { sessionId: "restarted" }]) {
      expect(completedTaskTabId({ ...binding, ...patch }, [tab], true, 60_000)).toBeNull();
    }
  });
  it.each(["running", "waiting", "pending", "failed"] as const)("does not close %s tasks", (status) => {
    expect(completedTaskTabId({ ...binding, status }, [tab], true, 60_000)).toBeNull();
  });
  it("preserves pinned, dirty, mixed-session splits and divergent layout copies", () => {
    for (const patch of [{ pinned: true }, { dirty: true }, { sessionId: "other" }, {
      terminalRootPane: { type: "split" as const, id: "split", direction: "horizontal" as const, sizes: [50, 50],
        children: [{ type: "leaf" as const, id: "a", sessionId: "pty" }, { type: "leaf" as const, id: "b", sessionId: "live" }] },
    }]) expect(completedTaskTabId(binding, [{ ...tab, ...patch }], true, 60_000)).toBeNull();
    expect(completedTaskTabId(binding, [tab, { ...tab, sessionId: "live" }], true, 60_000)).toBeNull();
    expect(completedTaskTabId(binding, [tab, { ...tab, id: "other-view" }], true, 60_000)).toBeNull();
  });
  it("requires actual exit AND persisted output; missing old-backend fields fail closed", () => {
    expect(hasRetainedExitedOutput({ sessionId: "pty", lines: ["result"], exited: true, retained: true }, "pty")).toBe(true);
    for (const fields of [{}, { exited: true }, { retained: true }, { exited: false, retained: true }]) {
      expect(hasRetainedExitedOutput({ sessionId: "pty", lines: [], ...fields }, "pty")).toBe(false);
    }
    expect(hasRetainedExitedOutput({ sessionId: "other", lines: [], exited: true, retained: true }, "pty")).toBe(false);
  });
});
