import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowUpRight, Clock3, Gauge } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { navigateToSettings } from "@/components/settings/settingsNavigation";
import {
  useActiveTerminalContext,
  type ActiveTerminalContext,
} from "@/hooks/useActiveTerminalSession";
import { useContextUsagePoller } from "@/hooks/useContextUsagePoller";
import { useLaunchProfilesStore } from "@/stores/useLaunchProfilesStore";
import { useProvidersStore } from "@/stores/useProvidersStore";
import { useContextUsageStore } from "@/stores/useContextUsageStore";
import type { ContextUsageSnapshot } from "@/types/contextUsage";
import { normalizeContextPercentage, resolveContextDisplayModel } from "@/utils/contextUsageModel";

const STALE_AFTER_MS = 25_000;

function formatTokens(value: number | null): string {
  if (value === null) return "-";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function statusColor(snapshot: ContextUsageSnapshot): string {
  if (snapshot.status === "error") return "var(--app-status-danger)";
  if (snapshot.status === "stale") return "var(--app-status-warning)";
  const percentage = normalizeContextPercentage(snapshot.usedPercentage);
  if (percentage === null) return "var(--app-text-secondary)";
  if (percentage >= 90) return "var(--app-status-danger)";
  if (percentage >= 50) return "var(--app-status-warning)";
  return "var(--app-status-success)";
}

function toStale(snapshot: ContextUsageSnapshot): ContextUsageSnapshot {
  return { ...snapshot, status: "stale" };
}

interface ContextUsageIndicatorProps {
  terminalContext?: ActiveTerminalContext | null;
  enabled?: boolean;
}

export default function ContextUsageIndicator({
  terminalContext,
  enabled = true,
}: ContextUsageIndicatorProps = {}) {
  const { t } = useTranslation("common");
  const sessionId = useContextUsagePoller(terminalContext, enabled);
  const storeSessionId = useContextUsageStore((state) => state.sessionId);
  const sessionEntry = useContextUsageStore((state) => (
    sessionId ? state.sessions.get(sessionId) : undefined
  ));
  const activeSnapshot = useContextUsageStore((state) => state.snapshot);
  const activeLastReady = useContextUsageStore((state) => state.lastReady);
  const activeTerminal = useActiveTerminalContext();
  const profiles = useLaunchProfilesStore((state) => state.profiles);
  const providers = useProvidersStore((state) => state.providers);
  const [now, setNow] = useState(() => Date.now());
  const resolvedTerminal = terminalContext === undefined ? activeTerminal : terminalContext;
  const snapshot = sessionEntry?.snapshot
    ?? (storeSessionId === sessionId ? activeSnapshot : null);
  const lastReady = sessionEntry?.lastReady
    ?? (storeSessionId === sessionId ? activeLastReady : null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

  const displaySnapshot = useMemo(() => {
    if (!sessionId) return null;
    if (!snapshot) {
      return {
        status: "waiting",
        usedTokens: null,
        effectiveUsedTokens: null,
        windowTokens: null,
        effectiveWindowTokens: null,
        usedPercentage: null,
        remainingPercentage: null,
        model: null,
        usageSource: null,
        windowSource: null,
        agentSessionId: null,
        parserVersion: null,
        observedAt: now,
        diagnosticCode: "WAITING_FIRST_RESPONSE",
      } satisfies ContextUsageSnapshot;
    }
    const age = now - snapshot.observedAt;
    if (age > STALE_AFTER_MS && lastReady) return toStale(lastReady);
    if ((snapshot.status === "error" || snapshot.status === "waiting") && lastReady) {
      return now - lastReady.observedAt > STALE_AFTER_MS ? toStale(lastReady) : lastReady;
    }
    return snapshot;
  }, [lastReady, now, sessionId, snapshot]);

  if (!displaySnapshot || displaySnapshot.diagnosticCode === "RUNTIME_UNSUPPORTED") return null;

  const percentage = normalizeContextPercentage(displaySnapshot.usedPercentage);
  const icon = displaySnapshot.status === "stale"
    ? <Clock3 className="h-3.5 w-3.5" />
    : displaySnapshot.status === "error"
      ? <AlertTriangle className="h-3.5 w-3.5" />
      : <Gauge className="h-3.5 w-3.5" />;
  const primary = percentage === null ? "-%" : `${percentage}%`;
  const rawSummary = `${formatTokens(displaySnapshot.usedTokens)} / ${formatTokens(displaySnapshot.windowTokens)}`;
  const effectiveDiffers = displaySnapshot.effectiveUsedTokens !== displaySnapshot.usedTokens
    || displaySnapshot.effectiveWindowTokens !== displaySnapshot.windowTokens;
  const ageSeconds = Math.max(0, Math.round((now - displaySnapshot.observedAt) / 1_000));
  const displayModel = resolvedTerminal
    ? resolveContextDisplayModel(resolvedTerminal, displaySnapshot.model, profiles, providers)
    : displaySnapshot.model;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="context-usage-indicator"
          aria-label={t("contextUsage.title")}
          className="flex h-full min-w-0 shrink-0 items-center gap-1.5 px-1.5 tabular-nums whitespace-nowrap max-[760px]:w-6 max-[760px]:justify-center max-[760px]:px-0"
          style={{ color: statusColor(displaySnapshot) }}
        >
          <span className="h-2 w-10 overflow-hidden rounded-[1px] border border-[var(--app-border)] bg-[var(--app-content)] p-px max-[760px]:hidden">
            <span
              className="block h-full transition-[width] duration-300"
              style={{
                width: `${Math.min(100, Math.max(0, percentage ?? 0))}%`,
                background: statusColor(displaySnapshot),
              }}
            />
          </span>
          <span className="hidden max-[760px]:inline-flex">{icon}</span>
          {(displaySnapshot.status === "stale" || displaySnapshot.status === "error") && (
            <span className="inline-flex max-[760px]:hidden">{icon}</span>
          )}
          <span className="max-[760px]:hidden">
            {primary}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={8}
        className="w-[200px] space-y-1 rounded-sm border border-[var(--app-border)] bg-[var(--app-overlay)] px-2.5 py-2 text-left text-[11px] text-[var(--app-text-secondary)] shadow-lg text-pretty"
      >
        <p className="flex items-center gap-1.5 font-semibold text-[var(--app-text-primary)]">
          <Gauge className="h-3 w-3 text-[var(--app-accent)]" />
          {t("contextUsage.title")}
        </p>
        {displaySnapshot.status === "waiting" && <p>{t("contextUsage.waiting")}</p>}
        {displaySnapshot.status === "error" && <p>{t("contextUsage.error")}</p>}
        {displaySnapshot.status === "stale" && <p>{t("contextUsage.stale", { seconds: ageSeconds })}</p>}
        {displaySnapshot.status !== "waiting" && displaySnapshot.status !== "error" && (
          <>
            <p className="tabular-nums">
              <span style={{ color: statusColor(displaySnapshot) }}>{primary}</span>
              <span> · {rawSummary}</span>
            </p>
            {displaySnapshot.diagnosticCode === "WINDOW_UNKNOWN" && (
              <button
                type="button"
                onClick={() => navigateToSettings({ paneId: "providers" })}
                aria-label={t("contextUsage.windowUnknownAction")}
                className="flex w-fit items-center gap-1 rounded text-left underline-offset-2 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-accent)]"
                style={{ color: "var(--app-status-danger)" }}
                data-testid="context-usage-window-unknown-link"
              >
                <span>{t("contextUsage.windowUnknown")}</span>
                <ArrowUpRight className="h-3 w-3 shrink-0" aria-hidden="true" />
              </button>
            )}
            {effectiveDiffers && (
              <p className="tabular-nums text-[var(--app-text-tertiary)]">
                {t("contextUsage.effective")}: {formatTokens(displaySnapshot.effectiveUsedTokens)} / {formatTokens(displaySnapshot.effectiveWindowTokens)}
              </p>
            )}
            {displayModel && <p className="truncate text-[var(--app-text-tertiary)]">{displayModel}</p>}
          </>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
