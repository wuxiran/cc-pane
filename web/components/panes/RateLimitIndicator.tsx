import { Gauge } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ActiveTerminalContext } from "@/hooks/useActiveTerminalSession";
import { useSessionCostStore } from "@/stores/useSessionCostStore";
import type { RateLimitWindow } from "@/types/rateLimit";
import {
  activeRateLimitWindows,
  formatDuration,
  formatPercent,
  formatWindowLength,
  mostConstrainedWindow,
  rateLimitSeverity,
  type RateLimitSeverity,
} from "@/utils/rateLimitDisplay";

const SEVERITY_COLOR: Record<RateLimitSeverity, string> = {
  normal: "var(--app-text-tertiary)",
  warning: "var(--app-status-warning)",
  danger: "var(--app-status-danger)",
};

interface RateLimitIndicatorProps {
  terminalContext: ActiveTerminalContext;
}

/**
 * 订阅额度（5 小时 / 每周窗口）。数据和会话费用同一次读取（同一份 transcript、
 * 同一个 10s 可见性轮询，由 SessionCostIndicator 驱动），这里只渲染。
 * 只有 CLI 在本地日志里写了额度时才出现——目前只有 Codex；没有数据就什么都不显示。
 */
export default function RateLimitIndicator({ terminalContext }: RateLimitIndicatorProps) {
  const { t } = useTranslation("common");
  const sessionId = terminalContext.ssh ? null : terminalContext.sessionId ?? null;
  const rateLimits = useSessionCostStore((state) => (
    sessionId ? state.sessions.get(sessionId)?.snapshot?.rateLimits ?? null : null
  ));
  const now = Date.now();
  const windows = activeRateLimitWindows(rateLimits, now);
  if (!rateLimits || windows.length === 0) return null;

  const limitReached = Boolean(rateLimits.limitReachedType);
  const worst = mostConstrainedWindow(windows);
  const windowName = (window: RateLimitWindow) => {
    if (window.windowMinutes === 300) return t("rateLimit.window.fiveHour");
    if (window.windowMinutes === 10080) return t("rateLimit.window.weekly");
    const length = formatWindowLength(window.windowMinutes);
    return length
      ? t("rateLimit.window.generic", { length })
      : t(window.slot === "secondary" ? "rateLimit.window.secondary" : "rateLimit.window.primary");
  };
  const shortName = (window: RateLimitWindow) => (
    formatWindowLength(window.windowMinutes) ?? (window.slot === "secondary" ? "2" : "1")
  );
  const resetIn = worst?.resetsAt ? formatDuration(worst.resetsAt - now) : null;
  const color = SEVERITY_COLOR[rateLimitSeverity(worst?.usedPercent ?? 0, limitReached)];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="rate-limit-indicator"
          aria-label={t("rateLimit.title")}
          className="flex shrink-0 items-center gap-0.5 tabular-nums whitespace-nowrap"
          style={{ color }}
        >
          <Gauge className="size-3" aria-hidden="true" />
          {windows.map((window) => `${shortName(window)} ${formatPercent(window.usedPercent)}`).join(" · ")}
          {resetIn ? <span style={{ color: "var(--app-text-tertiary)" }}>{` ↻${resetIn}`}</span> : null}
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={8}
        className="w-[260px] space-y-1 rounded-sm border border-[var(--app-border)] bg-[var(--app-overlay)] px-2.5 py-2 text-left text-[11px] text-[var(--app-text-secondary)] shadow-lg text-pretty"
      >
        <p className="font-semibold text-[var(--app-text-primary)]">
          {t("rateLimit.title")}
          {rateLimits.planType ? ` · ${rateLimits.planType}` : ""}
        </p>
        {windows.map((window) => (
          <div key={window.slot} className="space-y-0.5" data-testid="rate-limit-window">
            <p className="flex justify-between gap-2 tabular-nums">
              <span>{windowName(window)}</span>
              <span
                className="shrink-0"
                style={{ color: SEVERITY_COLOR[rateLimitSeverity(window.usedPercent)] }}
              >
                {t("rateLimit.used", { percent: formatPercent(window.usedPercent) })}
              </span>
            </p>
            <div className="h-1 overflow-hidden rounded-full bg-[var(--app-border)]">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.min(100, Math.max(0, window.usedPercent))}%`,
                  background: SEVERITY_COLOR[rateLimitSeverity(window.usedPercent)],
                }}
              />
            </div>
            {window.resetsAt ? (
              <p className="text-[var(--app-text-tertiary)]">
                {t("rateLimit.resetsAt", {
                  time: new Date(window.resetsAt).toLocaleString(),
                  in: formatDuration(window.resetsAt - now),
                })}
              </p>
            ) : null}
          </div>
        ))}
        {limitReached ? (
          <p style={{ color: "var(--app-status-danger)" }}>{t("rateLimit.reached")}</p>
        ) : null}
        <p className="text-[var(--app-text-tertiary)]">
          {rateLimits.observedAt
            ? t("rateLimit.sourceAt", { time: new Date(rateLimits.observedAt).toLocaleString() })
            : t("rateLimit.source")}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
