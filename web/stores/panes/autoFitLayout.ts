import type { PaneNode } from "@/types";

function leaves(node: PaneNode): number {
  return node.type === "panel" ? 1 : node.children.reduce((sum, child) => sum + leaves(child), 0);
}

/** Changes geometry only: every panel, tab and parent/child identity survives. */
export function autoFitPaneTree(node: PaneNode, width: number, height: number): PaneNode {
  if (node.type === "panel" || node.children.length === 0 || width <= 0 || height <= 0) return node;
  const weights = node.children.map(leaves), total = weights.reduce((a, b) => a + b, 0);
  const horizontal = width / height >= 1.6 && width * Math.min(...weights) / total >= 320;
  const direction = horizontal ? "horizontal" : "vertical";
  const sizes = weights.map(weight => Math.round(weight / total * 1000) / 10);
  sizes[sizes.length - 1] = Math.round((100 - sizes.slice(0, -1).reduce((a, b) => a + b, 0)) * 10) / 10;
  const children = node.children.map((child, i) => autoFitPaneTree(child,
    horizontal ? width * sizes[i] / 100 : width, horizontal ? height : height * sizes[i] / 100));
  if (direction === node.direction && sizes.every((v, i) => v === node.sizes[i]) && children.every((v, i) => v === node.children[i])) return node;
  return { ...node, direction, sizes, children };
}
