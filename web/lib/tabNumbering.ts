/**
 * Hierarchical tab numbering for a single panel.
 *
 * - Top-level tabs (no `parentTabId`, or `parentTabId` not present in this
 *   panel's tabs) are numbered by the order they appear in the `tabs` array:
 *   "1", "2", "3", …
 * - Children inherit their parent's prefix and gain `.k` in the order they
 *   appear within the tabs array: "2.1", "2.1.1", "2.2", …
 *
 * The function is pure and only depends on `tabs` array order + each tab's
 * `parentTabId`. Drag-reorder works without persistence: re-running the
 * function on the reordered array yields the new numbers.
 *
 * Two-pass algorithm:
 *  1. Walk tabs once to bucket every tab under its parent (root bucket = "").
 *     This keeps a parent->children order that matches the visible order.
 *  2. DFS from the root bucket and number each tab in order. Because step 1
 *     decoupled "find parent" from array position, parents that visually sit
 *     *after* their children (e.g. user drags child left of parent) still get
 *     a stable hierarchical number.
 *
 * Defensive against pathological data:
 * - Cycles in `parentTabId` (e.g. A→B→A) cannot occur from the backend event
 *   pipeline, but we still guard with a `visited` set so the DFS terminates
 *   regardless. Any tab the DFS can't reach from ROOT gets appended at the
 *   top level with a trailing number, ensuring every tab still gets a label.
 */
import type { PaneNode, Tab } from "@/types";

const ROOT = "";

export function computeTabNumbers(tabs: Tab[]): Map<string, string> {
  const result = new Map<string, string>();
  if (tabs.length === 0) return result;

  const tabIds = new Set(tabs.map((t) => t.id));
  // parent tab id -> ordered list of child tab ids
  const childrenByParent = new Map<string, string[]>();

  for (const tab of tabs) {
    const parent =
      tab.parentTabId && tabIds.has(tab.parentTabId) ? tab.parentTabId : ROOT;
    const bucket = childrenByParent.get(parent);
    if (bucket) bucket.push(tab.id);
    else childrenByParent.set(parent, [tab.id]);
  }

  // DFS from root with the parent's prefix string. `visited` makes the loop
  // safe against accidental cycles — a node visited twice is skipped.
  const visited = new Set<string>();
  const stack: Array<{ parent: string; prefix: string }> = [
    { parent: ROOT, prefix: "" },
  ];
  while (stack.length > 0) {
    const { parent, prefix } = stack.pop()!;
    const children = childrenByParent.get(parent);
    if (!children) continue;
    // Push in reverse so the stack pops them in array order.
    for (let i = children.length - 1; i >= 0; i--) {
      const childId = children[i];
      if (visited.has(childId)) continue;
      visited.add(childId);
      const idx = i + 1;
      const myNumber = prefix ? `${prefix}.${idx}` : String(idx);
      result.set(childId, myNumber);
      stack.push({ parent: childId, prefix: myNumber });
    }
  }

  // Unreachable tabs (only possible with a cycle) get appended to the top
  // level so every tab still has a stable number — never undefined.
  if (result.size < tabs.length) {
    let extra = (childrenByParent.get(ROOT)?.length ?? 0) + 1;
    for (const tab of tabs) {
      if (result.has(tab.id)) continue;
      result.set(tab.id, String(extra));
      extra += 1;
    }
  }

  return result;
}

export function computeGlobalTabNumbers(rootPane: PaneNode): Map<string, string> {
  return computeTabNumbers(collectTabsInPaneOrder(rootPane));
}

function collectTabsInPaneOrder(node: PaneNode): Tab[] {
  if (node.type === "panel") return node.tabs;
  return node.children.flatMap(collectTabsInPaneOrder);
}
