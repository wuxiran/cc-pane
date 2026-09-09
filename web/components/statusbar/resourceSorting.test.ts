import { expect, it } from "vitest";
import { sortResourceGroups } from "./resourceSorting";
import type { WorkspaceGroup } from "./SystemResourcePopover";

it("sorts sessions globally with stable ties without mutating the grouped view", () => {
  const groups = [{ name: "A", sessions: [{ sessionId: "b", cpuPercent: 4, memoryBytes: 30 }, { sessionId: "a", cpuPercent: 4, memoryBytes: 10 }] },
    { name: "B", sessions: [{ sessionId: "c", cpuPercent: 8, memoryBytes: 20 }] }] as WorkspaceGroup[];
  expect(sortResourceGroups(groups, "group", "Top")).toBe(groups);
  expect(sortResourceGroups(groups, "cpu", "Top")[0].sessions.map(s => s.sessionId)).toEqual(["c", "a", "b"]);
  expect(sortResourceGroups(groups, "memory", "Top")[0].sessions.map(s => s.sessionId)).toEqual(["b", "c", "a"]);
  expect(groups[0].sessions[0].sessionId).toBe("b");
});
