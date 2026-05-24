import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useOrchestratorStore } from "@/stores";
import type { TaskBindingNode } from "@/types";
import OrchestratorTaskCard from "./OrchestratorTaskCard";

function flattenVisible(
  nodes: TaskBindingNode[],
  expanded: Set<string>,
  depth = 0,
): Array<{ node: TaskBindingNode; depth: number }> {
  const result: Array<{ node: TaskBindingNode; depth: number }> = [];
  for (const node of nodes) {
    result.push({ node, depth });
    if (node.children.length > 0 && expanded.has(node.id)) {
      result.push(...flattenVisible(node.children, expanded, depth + 1));
    }
  }
  return result;
}

export default function OrchestratorTaskTree() {
  const bindings = useOrchestratorStore((s) => s.bindings);
  const getTaskTree = useOrchestratorStore((s) => s.getTaskTree);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const tree = useMemo(() => getTaskTree(), [bindings, getTaskTree]);
  const expanded = useMemo(() => {
    const set = new Set<string>();
    for (const binding of bindings) {
      if (!collapsed.has(binding.id)) set.add(binding.id);
    }
    return set;
  }, [bindings, collapsed]);
  const visibleNodes = useMemo(() => flattenVisible(tree, expanded), [expanded, tree]);

  return (
    <div className="space-y-0.5">
      {visibleNodes.map(({ node, depth }) => {
        const hasChildren = node.children.length > 0;
        const isExpanded = expanded.has(node.id);
        return (
          <div key={node.id} className="relative">
            <div
              className="absolute left-0 top-2 z-10 flex items-center"
              style={{ marginLeft: Math.max(0, depth * 14 - 4) }}
            >
              {hasChildren ? (
                <button
                  className="rounded p-0.5 hover:bg-[var(--app-hover)]"
                  onClick={(event) => {
                    event.stopPropagation();
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (isExpanded) {
                        next.add(node.id);
                      } else {
                        next.delete(node.id);
                      }
                      return next;
                    });
                  }}
                  title={isExpanded ? "Collapse" : "Expand"}
                >
                  {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                </button>
              ) : depth > 0 ? (
                <span className="px-1 text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>
                  ↪
                </span>
              ) : null}
            </div>
            {node.role === "worker" && (
              <span
                className="absolute right-2 top-2 z-10 rounded px-1 text-[9px]"
                style={{
                  color: "var(--app-text-tertiary)",
                  background: "var(--app-input-bg)",
                }}
              >
                ↪ worker
              </span>
            )}
            <OrchestratorTaskCard binding={node} depth={depth} />
          </div>
        );
      })}
    </div>
  );
}
