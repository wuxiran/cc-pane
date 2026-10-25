import { expect, it } from "vitest";
import type { PaneNode } from "@/types";
import { horizontalPaneNeighbors } from "./paneNeighbors";

const pane = (id: string): PaneNode => ({ type: "panel", id, tabs: [], activeTabId: "" });
it("moves horizontally in a nested layout without mistaking a lower pane for the right neighbour", () => {
  const root: PaneNode = { type: "split", id: "root", direction: "horizontal", sizes: [50, 50], children: [
    { type: "split", id: "left", direction: "vertical", sizes: [50, 50], children: [pane("top"), pane("bottom")] },
    pane("right"),
  ] };
  expect(horizontalPaneNeighbors(root, "top")).toEqual({ right: "right", left: undefined });
  expect(horizontalPaneNeighbors(root, "bottom")).toEqual({ right: "right", left: undefined });
  expect(horizontalPaneNeighbors({ type: "split", id: "vertical", direction: "vertical", sizes: [50, 50], children: [pane("a"), pane("b")] }, "a")).toEqual({});
  expect(horizontalPaneNeighbors({ type: "split", id: "collapsed", direction: "horizontal", sizes: [50, 0, 50], children: [pane("a"), pane("hidden"), pane("b")] }, "a")).toEqual({ right: "b" });
});
