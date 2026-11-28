import { useTranslation } from "react-i18next";
import { Circle, CircleCheck, CircleDot, CirclePause, CircleX, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWorkflowStore } from "@/stores";
import type { Workflow, WorkflowStageStatus } from "@/types";

/** 阶段状态 → 图标 + 状态色（docs/46 §3），与任务状态视觉同口径。 */
const STAGE_VISUALS: Record<WorkflowStageStatus, { icon: LucideIcon; color: string }> = {
  pending: { icon: Circle, color: "var(--app-text-tertiary)" },
  running: { icon: CircleDot, color: "var(--app-accent)" },
  waiting_approval: { icon: CirclePause, color: "var(--app-status-warning)" },
  done: { icon: CircleCheck, color: "var(--app-status-success)" },
  failed: { icon: CircleX, color: "var(--app-status-danger)" },
};

/** 父任务卡片下的阶段条：每段一枚状态徽章，等待审批的阶段带「批准」按钮。 */
export default function WorkflowStageStrip({ workflow }: { workflow: Workflow }) {
  const { t } = useTranslation("orchestration");
  const approve = useWorkflowStore((s) => s.approve);
  const approving = useWorkflowStore((s) => s.approving);

  return (
    <ol
      data-testid="workflow-stage-strip"
      aria-label={t("workflow.stages")}
      className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 px-2 pb-1"
    >
      {workflow.stages.map((stage) => {
        const visual = STAGE_VISUALS[stage.status] ?? STAGE_VISUALS.pending;
        const Icon = visual.icon;
        const done = stage.tasks.filter((task) => task.status === "done").length;
        const busy = approving[`${workflow.id}:${stage.index}`] === true;
        return (
          <li
            key={stage.index}
            data-testid="workflow-stage"
            data-status={stage.status}
            title={stage.error ?? t(`workflow.status.${stage.status}`)}
            className="inline-flex items-center gap-1 text-[length:var(--text-micro)]"
          >
            <Icon aria-hidden className="size-3" style={{ color: visual.color }} />
            <span className="text-[var(--app-text-secondary)]">{stage.title ?? stage.key}</span>
            <span className="text-[var(--app-text-tertiary)]">
              {done}/{stage.tasks.length}
            </span>
            {stage.status === "waiting_approval" && (
              <Button
                size="xs"
                variant="secondary"
                className="h-5 px-1.5"
                disabled={busy}
                onClick={(event) => {
                  event.stopPropagation();
                  void approve(workflow.id, stage.index);
                }}
              >
                {t("workflow.approve")}
              </Button>
            )}
          </li>
        );
      })}
    </ol>
  );
}
