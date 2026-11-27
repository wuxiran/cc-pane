import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, CornerDownRight } from "lucide-react";
import { useOrchestratorStore, useWorkflowStore } from "@/stores";
import type { TaskBindingNode } from "@/types";
import OrchestratorTaskCard from "./OrchestratorTaskCard";
import WorkflowStageStrip from "./WorkflowStageStrip";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";

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

const INDENT_STEP = 14;
const MAX_INDENT = 42;

export default function OrchestratorTaskTree() {
  const { t } = useTranslation("orchestration");
  const bindings = useOrchestratorStore((s) => s.bindings);
  const getTaskTree = useOrchestratorStore((s) => s.getTaskTree);
  const workflows = useWorkflowStore((s) => s.byId);
  const loadWorkflows = useWorkflowStore((s) => s.load);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    void loadWorkflows();
  }, [loadWorkflows]);
  const tree = useMemo(() => getTaskTree(), [bindings, getTaskTree]);
  const expanded = useMemo(() => {
    const set = new Set<string>();
    for (const binding of bindings) {
      if (!collapsed.has(binding.id)) set.add(binding.id);
    }
    return set;
  }, [bindings, collapsed]);
  const visibleNodes = useMemo(() => flattenVisible(tree, expanded), [expanded, tree]);

  const toggle = (id: string, isExpanded: boolean) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (isExpanded) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  return (
    <div className="space-y-0.5">
      {visibleNodes.map(({ node, depth }) => {
        const hasChildren = node.children.length > 0;
        const isExpanded = expanded.has(node.id);
        const toggleLabel = isExpanded ? t("tree.collapse") : t("tree.expand");
        return (
          // 左侧固定 16px 槽位放折叠钮 / 子级连接符，卡片本身不再被覆盖
          <div
            key={node.id}
            data-testid="task-tree-row"
            data-role={node.role}
            className="flex items-start gap-0.5"
            style={{ paddingLeft: Math.min(depth * INDENT_STEP, MAX_INDENT) }}
          >
            <div className="flex w-4 shrink-0 justify-center pt-3 text-[var(--app-text-tertiary)]">
              {hasChildren ? (
                <IconTooltipButton
                  label={toggleLabel}
                  className="size-4 p-0"
                  onClick={(event) => {
                    event.stopPropagation();
                    toggle(node.id, isExpanded);
                  }}
                >
                  {isExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                </IconTooltipButton>
              ) : depth > 0 ? (
                <CornerDownRight aria-hidden data-testid="tree-child-connector" className="size-3" />
              ) : null}
            </div>
            <div className="min-w-0 flex-1">
              <OrchestratorTaskCard binding={node} depth={depth} indent={false} />
              {workflows[node.id] && <WorkflowStageStrip workflow={workflows[node.id]} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}
