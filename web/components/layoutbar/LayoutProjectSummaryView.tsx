import StatusIndicator from "@/components/StatusIndicator";
import type { LayoutProjectSummary } from "./layoutProjectSummary";

export default function LayoutProjectSummaryView({
  summary,
  idleLabel,
}: {
  summary: LayoutProjectSummary;
  idleLabel: string;
}) {
  if (summary.projects.length === 0) {
    return <span className="truncate">{idleLabel}</span>;
  }

  return (
    <span className="flex min-w-0 items-center gap-1 overflow-hidden">
      {summary.projects.map((project, index) => (
        <span key={project.id} className="contents">
          {index > 0 ? <span aria-hidden>·</span> : null}
          <span className="flex min-w-0 items-center gap-1">
            <span className="max-w-[72px] truncate">{project.name}</span>
            <StatusIndicator status={project.status} size={5} />
          </span>
        </span>
      ))}
      {summary.overflow > 0 ? <span className="shrink-0">+{summary.overflow}</span> : null}
    </span>
  );
}
