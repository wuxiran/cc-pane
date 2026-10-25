import type { PaneNode } from "@/types";

interface PaneRect { id: string; x: number; y: number; width: number; height: number }

function rectangles(node: PaneNode, rect: Omit<PaneRect, "id">): PaneRect[] {
  if (node.type === "panel") return [{ id: node.id, ...rect }];
  const sizes = node.children.map((_, i) => Number.isFinite(node.sizes[i]) ? Math.max(0, node.sizes[i]) : 1);
  const total = sizes.reduce((sum, value) => sum + value, 0);
  let offset = 0;
  return node.children.flatMap((child, i) => {
    const fraction = total > 0 ? sizes[i] / total : 1 / sizes.length;
    if (fraction === 0) return [];
    const childRect = node.direction === "horizontal"
      ? { ...rect, x: rect.x + rect.width * offset, width: rect.width * fraction }
      : { ...rect, y: rect.y + rect.height * offset, height: rect.height * fraction };
    offset += fraction;
    return rectangles(child, childRect);
  });
}

/** Choose a spatial neighbour, never a pane merely below in tree traversal order. */
export function horizontalPaneNeighbors(root: PaneNode, paneId: string): { left?: string; right?: string } {
  const panes = rectangles(root, { x: 0, y: 0, width: 1, height: 1 });
  const source = panes.find((pane) => pane.id === paneId);
  if (!source) return {};
  const candidates = panes.filter((pane) => pane.id !== paneId
    && Math.min(pane.y + pane.height, source.y + source.height) - Math.max(pane.y, source.y) > 0.000001);
  const score = (pane: PaneRect) => Math.max(pane.x - source.x - source.width, source.x - pane.x - pane.width, 0)
    + Math.abs(pane.y + pane.height / 2 - source.y - source.height / 2);
  const nearest = (direction: "left" | "right") => candidates
    .filter((pane) => direction === "left"
      ? pane.x + pane.width <= source.x + 0.000001 : pane.x >= source.x + source.width - 0.000001)
    .sort((a, b) => score(a) - score(b))[0]?.id;
  return { left: nearest("left"), right: nearest("right") };
}
