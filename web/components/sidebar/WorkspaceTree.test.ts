import { describe, expect, it } from "vitest";
import { createTestWorkspace, resetTestDataCounter } from "@/test/utils/testData";
import { getReorderedWorkspaceNames } from "./WorkspaceTree";

describe("getReorderedWorkspaceNames", () => {
  it("returns reordered workspace names within the same pinned group", () => {
    resetTestDataCounter();
    const ws1 = createTestWorkspace({ id: "ws-1", name: "ws-1", pinned: false });
    const ws2 = createTestWorkspace({ id: "ws-2", name: "ws-2", pinned: false });
    const ws3 = createTestWorkspace({ id: "ws-3", name: "ws-3", pinned: false });

    expect(
      getReorderedWorkspaceNames([ws1, ws2, ws3], "ws-3", "ws-1"),
    ).toEqual(["ws-3", "ws-1", "ws-2"]);
  });

  it("ignores drag attempts across pinned boundaries", () => {
    resetTestDataCounter();
    const pinned = createTestWorkspace({ id: "ws-1", name: "ws-1", pinned: true });
    const normal = createTestWorkspace({ id: "ws-2", name: "ws-2", pinned: false });

    expect(
      getReorderedWorkspaceNames([pinned, normal], "ws-2", "ws-1"),
    ).toBeNull();
  });
});
