import { describe, expect, it } from "vitest";
import {
  formatContentSize,
  groupPanelsByWorkspace,
} from "@/components/aipanel/aiPanelGrouping";
import type { AiPanelSummary } from "@/types/aiPanel";

function summary(panelId: string, workspaceName: string | null): AiPanelSummary {
  return {
    panelId,
    workspaceName,
    projectPath: "D:/repo",
    title: `Panel ${panelId}`,
    format: "html",
    driverName: "Worker A",
    ownerSessionId: null,
    contentBytes: 128,
    createdAt: "2026-07-26T10:00:00Z",
    updatedAt: "2026-07-26T10:00:00Z",
  };
}

describe("groupPanelsByWorkspace", () => {
  it("aggregates adjacent panels sharing a workspace", () => {
    const groups = groupPanelsByWorkspace([
      summary("a", "alpha"),
      summary("b", "alpha"),
      summary("c", "beta"),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]!.workspaceName).toBe("alpha");
    expect(groups[0]!.panels.map((p) => p.panelId)).toEqual(["a", "b"]);
    expect(groups[1]!.panels.map((p) => p.panelId)).toEqual(["c"]);
  });

  it("keeps the backend ordering rather than re-sorting", () => {
    // 后端把未归类 (null) 排在最后；本地重排会打乱这个规则
    const groups = groupPanelsByWorkspace([
      summary("a", "zeta"),
      summary("b", "alpha"),
      summary("c", null),
    ]);

    expect(groups.map((group) => group.workspaceName)).toEqual(["zeta", "alpha", null]);
  });

  it("does not merge same-workspace runs that are not adjacent", () => {
    const groups = groupPanelsByWorkspace([
      summary("a", "alpha"),
      summary("b", "beta"),
      summary("c", "alpha"),
    ]);

    expect(groups).toHaveLength(3);
  });

  it("returns nothing for an empty history", () => {
    expect(groupPanelsByWorkspace([])).toEqual([]);
  });
});

describe("formatContentSize", () => {
  it("scales units so users can judge what is worth deleting", () => {
    expect(formatContentSize(512)).toBe("512 B");
    expect(formatContentSize(2048)).toBe("2 KB");
    expect(formatContentSize(256 * 1024)).toBe("256 KB");
    expect(formatContentSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
