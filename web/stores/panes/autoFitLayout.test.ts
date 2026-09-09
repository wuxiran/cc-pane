import { expect, it } from "vitest";
import type { PaneNode } from "@/types";
import { autoFitPaneTree } from "./autoFitLayout";

it("adapts geometry without replacing panels, moving tabs or losing drafts", () => {
  const first = { type: "panel", id: "p1", activeTabId: "t1", tabs: [{ id: "t1", sessionId: "live", title: "draft" }] } as PaneNode;
  const second = { type: "panel", id: "p2", activeTabId: "t2", tabs: [{ id: "t2", sessionId: "live2" }] } as PaneNode;
  const tree: PaneNode = { type: "split", id: "root", direction: "vertical", sizes: [20, 80], children: [first, second] };
  const wide = autoFitPaneTree(tree, 1600, 700);
  expect(wide).toMatchObject({ id: "root", direction: "horizontal", sizes: [50, 50] });
  if (wide.type !== "split") throw new Error("split missing");
  expect(wide.children[0]).toBe(first);
  expect(wide.children[1]).toBe(second);
  expect(autoFitPaneTree(wide, 1600, 700)).toBe(wide);
  expect(autoFitPaneTree(wide, 600, 800)).toMatchObject({ direction: "vertical" });
  expect(tree.direction).toBe("vertical");
});
