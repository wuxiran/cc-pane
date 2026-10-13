import { ChevronDown, ChevronRight, SquareTerminal, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import StatusIndicator from "@/components/StatusIndicator";
import { Button } from "@/components/ui/button";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import type { SessionView } from "./SystemResourcePopover";
import { useSessionResourcePolicy, type SessionPolicyMode } from "./useSessionResourcePolicy";
import { formatSize } from "@/utils";

const MODES: SessionPolicyMode[] = ["normal", "yield", "eco"];

function formatCpu(cpuPercent: number): string {
  return `${Math.round(cpuPercent * 10) / 10}%`;
}

interface SystemResourceSessionRowProps {
  session: SessionView;
  armed: boolean;
  killing: boolean;
  expanded: boolean;
  /** 从标签琥珀点进来时高亮并滚到可见。 */
  highlighted: boolean;
  onToggleProcesses: (sessionId: string) => void;
  onFocus: (sessionId: string) => void;
  onArm: (sessionId: string) => void;
  onKill: (sessionId: string) => void;
}

/** 资源管理器里的一行受管会话：状态 / 读数 / 三态策略 / 进程明细 / 结束。 */
export function SystemResourceSessionRow({
  session,
  armed,
  killing,
  expanded: expandedProp,
  highlighted,
  onToggleProcesses,
  onFocus,
  onArm,
  onKill,
}: SystemResourceSessionRowProps) {
  const { t } = useTranslation("common");
  const policy = useSessionResourcePolicy(session.sessionId);
  const rowRef = useRef<HTMLDivElement>(null);
  const processes = session.processes ?? [];
  // 旧后端不返回明细字段；此时退回成"没有可展开的东西"，不显示假的展开箭头。
  const expandable = processes.length > 0;
  const expanded = expandable && expandedProp;

  useEffect(() => {
    if (highlighted) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  return (
    <div
      ref={rowRef}
      data-testid={`resource-session-${session.sessionId}`}
      className={highlighted ? "rounded ring-1 ring-[var(--app-status-warning)]" : undefined}
    >
      <div className="group flex h-8 items-center gap-1 pl-2 pr-1">
        {expandable ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={t(
              expanded ? "resourceManagerCollapseProcesses" : "resourceManagerExpandProcesses",
              { name: session.title },
            )}
            className="flex size-4 shrink-0 items-center justify-center rounded text-[var(--app-text-tertiary)] hover:bg-[var(--app-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-accent)]"
            onClick={() => onToggleProcesses(session.sessionId)}
          >
            {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </button>
        ) : (
          <span className="size-4 shrink-0" aria-hidden />
        )}
        <button
          type="button"
          aria-label={`${session.adoptable ? t("resourceManagerAdopt") : t("resourceManagerFocusSession")}: ${session.title}`}
          title={
            session.claimBlocked
              ? t("resourceManagerAdoptClaimed")
              : session.adoptable
                ? t("resourceManagerAdopt")
                : `${session.title}\n${session.workspaceName}`
          }
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-[var(--app-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-accent)]"
          disabled={session.claimBlocked}
          onClick={() => onFocus(session.sessionId)}
        >
          <StatusIndicator status={session.status} toolName={session.toolName} size={7} />
          <SquareTerminal className="size-3.5 shrink-0 text-[var(--app-text-tertiary)]" />
          <span className="shrink-0 text-[10px] uppercase text-[var(--app-text-tertiary)]">
            {session.cliTool === "none" ? "CLI" : session.cliTool}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-[var(--app-text-primary)]">
            {session.title}
          </span>
          {/* 数字本来就是整棵进程树的聚合，但只显示 CPU/内存时"含不含子进程"完全看不出来。 */}
          {session.processCount > 1 && (
            <span className="shrink-0 rounded bg-[var(--app-hover)] px-1 text-[10px] tabular-nums text-[var(--app-text-tertiary)]">
              {t("resourceManagerProcessCount", { count: session.processCount })}
            </span>
          )}
          <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-[var(--app-text-secondary)]">
            {formatCpu(session.cpuPercent)}
          </span>
          <span className="w-[58px] shrink-0 text-right text-[11px] tabular-nums text-[var(--app-text-secondary)]">
            {formatSize(session.memoryBytes)}
          </span>
        </button>
        {/* 三态：正常 / 让路 / 效率模式。只在本机进程上有意义，SSH 会显示"不支持"。 */}
        <div
          role="radiogroup"
          aria-label={t("resourcePolicyGroup", { name: session.title })}
          className="flex shrink-0 items-center rounded border border-[var(--app-border)] text-[10px]"
        >
          {MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={policy.mode === mode}
              disabled={policy.pending}
              title={t(`resourcePolicyHint_${mode}`)}
              className={`px-1.5 py-0.5 ${
                policy.mode === mode
                  ? "bg-[var(--app-active-bg)] text-[var(--app-text-primary)]"
                  : "text-[var(--app-text-tertiary)] hover:bg-[var(--app-hover)]"
              }`}
              onClick={() => void policy.setMode(mode)}
            >
              {t(`resourcePolicy_${mode}`)}
            </button>
          ))}
        </div>
        {armed ? (
          <Button
            size="sm"
            variant="destructive"
            className="h-6 px-2 text-[11px]"
            disabled={killing}
            onClick={() => onKill(session.sessionId)}
          >
            {t("resourceManagerConfirmEnd")}
          </Button>
        ) : (
          <IconTooltipButton
            label={t("resourceManagerEndSessionNamed", { name: session.title })}
            className="h-6 w-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-[var(--app-status-danger-bg)] hover:text-[var(--app-status-danger)]"
            onClick={() => onArm(session.sessionId)}
          >
            <X className="size-3.5" />
          </IconTooltipButton>
        )}
      </div>
      {/* 降级必须可见（docs/45）：不是 applied 就把原因贴在行下。 */}
      {policy.status && policy.status.outcome !== "applied" && (
        <div
          className="flex min-h-5 items-center pl-9 pr-2 text-[11px]"
          style={{ color: "var(--app-status-warning)" }}
          data-testid="resource-policy-degraded"
        >
          {t(
            policy.status.outcome === "degraded"
              ? "resourcePolicyDegraded"
              : "resourcePolicyUnsupported",
            { reason: policy.status.reason ?? t("resourcePolicyNoReason") },
          )}
        </div>
      )}
      {expanded && (
        <div className="mb-1">
          {processes.map((process) => (
            <div key={process.pid} className="flex min-h-6 items-center gap-2 pl-9 pr-2 text-[11px]">
              <span className="min-w-0 flex-1 truncate text-[var(--app-text-secondary)]" title={process.command}>
                {process.name}
              </span>
              <span className="shrink-0 tabular-nums text-[var(--app-text-tertiary)]">
                PID {process.pid} · {formatCpu(process.cpuPercent)} · {formatSize(process.memoryBytes)}
              </span>
            </div>
          ))}
          {/* 截断必须可见：不说"另有 N 个"，用户会以为上面就是全部。 */}
          {session.truncated && (
            <div className="flex min-h-6 items-center gap-2 pl-9 pr-2 text-[11px] text-[var(--app-text-tertiary)]">
              <span className="min-w-0 flex-1 truncate italic">
                {t("resourceManagerMoreProcesses", { count: session.truncated.processCount })}
              </span>
              <span className="shrink-0 tabular-nums">
                {formatCpu(session.truncated.cpuPercent)} · {formatSize(session.truncated.memoryBytes)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default SystemResourceSessionRow;
