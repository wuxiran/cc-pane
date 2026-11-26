import { useTranslation } from "react-i18next";
import {
  Circle,
  CircleCheck,
  CircleDot,
  CirclePause,
  CircleX,
  ClipboardList,
  Cog,
  Target,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { TaskBinding, TaskBindingRole } from "@/types";

/**
 * 任务结果态 → 状态色（docs/46 §3）：运行中是进行态用 accent，只有 completed 用 success；
 * 等待输入用琥珀，且每一态都配不同形状的图标 + 文字，不只靠颜色区分。
 */
const STATUS_VISUALS: Record<TaskBinding["status"], { icon: LucideIcon; color: string }> = {
  pending: { icon: Circle, color: "var(--app-text-tertiary)" },
  running: { icon: CircleDot, color: "var(--app-accent)" },
  waiting: { icon: CirclePause, color: "var(--app-status-warning)" },
  completed: { icon: CircleCheck, color: "var(--app-status-success)" },
  failed: { icon: CircleX, color: "var(--app-status-danger)" },
};

export const ROLE_ICONS: Record<TaskBindingRole, LucideIcon> = {
  task: Target,
  leader: ClipboardList,
  worker: Cog,
};

export function TaskStatusLabel({ status, className }: { status: TaskBinding["status"]; className?: string }) {
  const { t } = useTranslation("orchestration");
  const visual = STATUS_VISUALS[status] ?? STATUS_VISUALS.pending;
  const Icon = visual.icon;
  return (
    <span
      data-testid="task-status"
      data-status={status}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-[length:var(--text-micro)] font-medium",
        className,
      )}
      style={{ color: visual.color }}
    >
      <Icon aria-hidden className="size-3" />
      {t(`status.${status}`)}
    </span>
  );
}

export function TaskRoleIcon({ role, className }: { role: TaskBindingRole; className?: string }) {
  const { t } = useTranslation("orchestration");
  const Icon = ROLE_ICONS[role] ?? ROLE_ICONS.task;
  const label = t(`role.${role}`);
  return (
    <span role="img" aria-label={label} className={cn("inline-flex shrink-0", className)}>
      <Icon aria-hidden className="size-3.5" />
    </span>
  );
}
