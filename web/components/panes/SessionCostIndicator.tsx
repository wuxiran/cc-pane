import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ActiveTerminalContext } from "@/hooks/useActiveTerminalSession";
import { useSessionCostStore } from "@/stores/useSessionCostStore";
import { startVisibleInterval } from "@/utils/visibleInterval";

const POLL_INTERVAL_MS = 10_000;
const NO_COST_LABEL = "$—";

export function formatUsd(value: number): string {
  if (value < 0.01) return "<$0.01";
  if (value < 100) return `$${value.toFixed(2)}`;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

interface SessionCostIndicatorProps {
  terminalContext: ActiveTerminalContext;
  enabled?: boolean;
}

export default function SessionCostIndicator({
  terminalContext,
  enabled = true,
}: SessionCostIndicatorProps) {
  const { t } = useTranslation("common");
  const { cliTool, ssh } = terminalContext;
  const supported = !ssh && (cliTool === "claude" || cliTool === "codex");
  const sessionId = supported ? terminalContext.sessionId ?? null : null;
  const loadSession = useSessionCostStore((state) => state.loadSession);
  const snapshot = useSessionCostStore((state) => (
    sessionId ? state.sessions.get(sessionId)?.snapshot ?? null : null
  ));

  useEffect(() => {
    if (!enabled || !sessionId) return;
    void loadSession(sessionId);
    return startVisibleInterval(() => void loadSession(sessionId), POLL_INTERVAL_MS);
  }, [enabled, loadSession, sessionId]);

  if (!sessionId || snapshot?.diagnosticCode === "RUNTIME_UNSUPPORTED") return null;

  const ready = snapshot?.status === "ready";
  const costUsd = ready ? snapshot.costUsd : null;
  const partial = ready && snapshot.hasUnpricedUsage && costUsd !== null;
  const label = costUsd === null ? NO_COST_LABEL : `≈${formatUsd(costUsd)}${partial ? "+" : ""}`;
  const unpricedModels = ready
    ? snapshot.models.filter((entry) => entry.costUsd === null).map((entry) => entry.model)
    : [];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="session-cost-indicator"
          aria-label={t("sessionCost.title")}
          className="shrink-0 tabular-nums whitespace-nowrap"
          style={{ color: "var(--app-text-tertiary)" }}
        >
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={8}
        className="w-[240px] space-y-1 rounded-sm border border-[var(--app-border)] bg-[var(--app-overlay)] px-2.5 py-2 text-left text-[11px] text-[var(--app-text-secondary)] shadow-lg text-pretty"
      >
        <p className="font-semibold text-[var(--app-text-primary)]">{t("sessionCost.title")}</p>
        {!snapshot || snapshot.status === "waiting" ? <p>{t("sessionCost.waiting")}</p> : null}
        {snapshot?.status === "error" ? <p>{t("sessionCost.error")}</p> : null}
        {ready ? (
          <>
            {[
              { label: t("sessionCost.input"), value: snapshot.inputTokens },
              { label: t("sessionCost.output"), value: snapshot.outputTokens },
              { label: t("sessionCost.cacheRead"), value: snapshot.cacheReadTokens },
              { label: t("sessionCost.cacheWrite"), value: snapshot.cacheWriteTokens },
            ].map(({ label, value }) => (
              <p key={label} className="flex justify-between gap-2 tabular-nums">
                <span>{label}</span>
                <span className="shrink-0 text-[var(--app-text-primary)]">{formatTokens(value)}</span>
              </p>
            ))}
            {snapshot.models.length > 1 ? snapshot.models
              .filter((entry) => entry.costUsd !== null)
              .map((entry) => (
                <p key={entry.model} className="flex justify-between gap-2 tabular-nums">
                  <span className="truncate">{entry.model}</span>
                  <span className="shrink-0">{formatUsd(entry.costUsd ?? 0)}</span>
                </p>
              )) : null}
            {unpricedModels.length > 0 ? (
              <p style={{ color: "var(--app-status-warning)" }}>
                {t("sessionCost.unpriced", { models: unpricedModels.join(", ") })}
              </p>
            ) : null}
            <p className="text-[var(--app-text-tertiary)]">
              {t("sessionCost.disclaimer", { date: snapshot.pricingAsOf })}
            </p>
          </>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}
