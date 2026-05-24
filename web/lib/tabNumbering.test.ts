import { describe, it, expect } from "vitest";
import { computeGlobalTabNumbers, computeTabNumbers } from "./tabNumbering";
import type { PaneNode, Tab } from "@/types";

function tab(id: string, parentTabId?: string): Tab {
  return {
    id,
    title: id,
    contentType: "terminal",
    projectId: "p",
    projectPath: "/",
    sessionId: null,
    parentTabId,
  };
}

function panel(id: string, tabs: Tab[]): PaneNode {
  return {
    type: "panel",
    id,
    activeTabId: tabs[0]?.id ?? "",
    tabs,
  };
}

function split(children: PaneNode[]): PaneNode {
  return {
    type: "split",
    id: "split",
    direction: "horizontal",
    children,
    sizes: children.map(() => 100 / children.length),
  };
}

describe("computeTabNumbers", () => {
  it("returns empty map for empty array", () => {
    expect(computeTabNumbers([])).toEqual(new Map());
  });

  it("numbers top-level tabs by position", () => {
    const result = computeTabNumbers([tab("a"), tab("b"), tab("c")]);
    expect(result.get("a")).toBe("1");
    expect(result.get("b")).toBe("2");
    expect(result.get("c")).toBe("3");
  });

  it("numbers children with dotted prefix", () => {
    // parent at position 2, children #2.1 #2.2
    const result = computeTabNumbers([
      tab("a"),
      tab("b"),
      tab("b1", "b"),
      tab("b2", "b"),
      tab("c"),
    ]);
    expect(result.get("a")).toBe("1");
    expect(result.get("b")).toBe("2");
    expect(result.get("b1")).toBe("2.1");
    expect(result.get("b2")).toBe("2.2");
    expect(result.get("c")).toBe("3");
  });

  it("supports nested grandchildren #2.1.1", () => {
    const result = computeTabNumbers([
      tab("a"),
      tab("b"),
      tab("b1", "b"),
      tab("b1a", "b1"),
      tab("b1b", "b1"),
      tab("b2", "b"),
    ]);
    expect(result.get("b1")).toBe("2.1");
    expect(result.get("b1a")).toBe("2.1.1");
    expect(result.get("b1b")).toBe("2.1.2");
    expect(result.get("b2")).toBe("2.2");
  });

  it("renumbers after reorder: child follows parent", () => {
    // Drag tab c to the front → it becomes #1, b becomes #2, child b1 stays #2.1.
    const result = computeTabNumbers([
      tab("c"),
      tab("a"),
      tab("b"),
      tab("b1", "b"),
    ]);
    expect(result.get("c")).toBe("1");
    expect(result.get("a")).toBe("2");
    expect(result.get("b")).toBe("3");
    expect(result.get("b1")).toBe("3.1");
  });

  it("treats orphans (parent missing in this panel) as top-level", () => {
    // b1 references unknown parent "ghost" → falls back to top level.
    const result = computeTabNumbers([tab("a"), tab("b1", "ghost")]);
    expect(result.get("a")).toBe("1");
    expect(result.get("b1")).toBe("2");
  });

  it("handles child sitting before parent in array — keeps the parent link", () => {
    // User drags a child tab visually before its parent. Since the parent
    // tab still exists in this panel, the hierarchical relationship is the
    // source of truth — child stays #N.M rather than degrading to top-level.
    const result = computeTabNumbers([
      tab("b1", "b"),
      tab("b"),
      tab("a"),
    ]);
    expect(result.get("b")).toBe("1");
    expect(result.get("b1")).toBe("1.1");
    expect(result.get("a")).toBe("2");
  });

  it("does not loop on cycles — every tab still gets a top-level number", () => {
    // Pathological data: A.parent=B, B.parent=A. The backend event pipeline
    // can't produce this, but if it ever did we must terminate and still
    // label every tab so the TabBar doesn't render undefined.
    const result = computeTabNumbers([tab("a", "b"), tab("b", "a")]);
    expect(result.size).toBe(2);
    expect(result.get("a")).toBeDefined();
    expect(result.get("b")).toBeDefined();
    // The exact numbers don't matter — only that both are top-level strings.
    expect(result.get("a")).toMatch(/^\d+$/);
    expect(result.get("b")).toMatch(/^\d+$/);
  });

  it("numbers top-level tabs globally across panes", () => {
    const result = computeGlobalTabNumbers(split([
      panel("p1", [tab("a")]),
      panel("p2", [tab("b")]),
      panel("p3", [tab("c")]),
    ]));

    expect(result.get("a")).toBe("1");
    expect(result.get("b")).toBe("2");
    expect(result.get("c")).toBe("3");
  });

  it("keeps child numbering when parent and child are in different panes", () => {
    const result = computeGlobalTabNumbers(split([
      panel("p1", [tab("parent")]),
      panel("p2", [tab("child", "parent")]),
      panel("p3", [tab("sibling")]),
    ]));

    expect(result.get("parent")).toBe("1");
    expect(result.get("child")).toBe("1.1");
    expect(result.get("sibling")).toBe("2");
  });
});
