import { describe, expect, it } from "vitest";
import { CLOSED_TABS_LIMIT, trimClosedTabs } from "./closedTabsCap";
import type { ClosedTabSnapshot } from "./panesStoreTypes";

function snapshot(i: number): ClosedTabSnapshot {
  return { projectId: `proj-${i}`, projectPath: `/tmp/proj-${i}`, title: `Tab ${i}` };
}

describe("trimClosedTabs", () => {
  it("超上限时原地裁剪，保留尾部（最近关闭的）", () => {
    const list = Array.from({ length: 30 }, (_, i) => snapshot(i));
    const result = trimClosedTabs(list);

    expect(result).toBe(list); // 原地
    expect(list).toHaveLength(CLOSED_TABS_LIMIT);
    expect(list[0].projectId).toBe("proj-10");
    expect(list[list.length - 1].projectId).toBe("proj-29");
  });

  it("未超上限时不动", () => {
    const list = Array.from({ length: 5 }, (_, i) => snapshot(i));
    trimClosedTabs(list);
    expect(list).toHaveLength(5);
    expect(list[0].projectId).toBe("proj-0");
  });

  it("空数组安全", () => {
    const list: ClosedTabSnapshot[] = [];
    expect(trimClosedTabs(list)).toHaveLength(0);
  });

  it("支持自定义上限", () => {
    const list = Array.from({ length: 10 }, (_, i) => snapshot(i));
    trimClosedTabs(list, 3);
    expect(list.map((s) => s.projectId)).toEqual(["proj-7", "proj-8", "proj-9"]);
  });
});
