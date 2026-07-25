import { AlertTriangle, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useOrchestratorStatus } from "@/hooks/useOrchestratorStatus";

function formatRetryTime(timestamp: number | null): string | null {
  if (timestamp == null) return null;
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default function OrchestratorAlertBanner() {
  const { t } = useTranslation("settings");
  const status = useOrchestratorStatus();

  if (
    !status ||
    status.lifecycle === "ready" ||
    (status.lifecycle === "binding" && status.lastError == null)
  ) {
    return null;
  }

  const failed = status.lifecycle === "failed";
  const retryTime = formatRetryTime(status.nextRetryAt);
  const Icon = failed ? AlertTriangle : LoaderCircle;

  return (
    <section
      role={failed ? "alert" : "status"}
      aria-live={failed ? "assertive" : "polite"}
      className="relative z-[2] flex shrink-0 items-start gap-2.5 border-y px-3 py-2 text-xs"
      style={{
        borderColor: failed ? "var(--app-status-danger-border)" : "var(--app-status-warning-border)",
        background: failed ? "var(--app-status-danger-bg)" : "var(--app-status-warning-bg)",
        color: failed ? "var(--app-status-danger)" : "var(--app-status-warning)",
      }}
    >
      <Icon className={`mt-0.5 size-4 shrink-0 ${failed ? "" : "animate-spin"}`} />
      <div className="min-w-0 flex-1">
        <p className="m-0 font-medium">
          {failed
            ? t("orchestratorAlert.failedTitle")
            : retryTime
              ? t("orchestratorAlert.retrying", {
                  attempt: status.attempt,
                  time: retryTime,
                })
              : t("orchestratorAlert.attempting", { attempt: status.attempt })}
        </p>
        <p className="m-0 mt-0.5 text-[11px] text-[var(--app-text-secondary)]">
          {t("orchestratorAlert.impact")} {t("orchestratorAlert.escapePrefix")} {" "}
          <code className="font-mono text-[inherit]">CC_PANES_ORCHESTRATOR_PORT</code>{" "}
          {t("orchestratorAlert.escapeSuffix")}
        </p>
        {failed && status.lastError && (
          <details className="mt-1 text-[11px] text-[var(--app-text-secondary)]">
            <summary className="w-fit cursor-pointer">{t("orchestratorAlert.errorDetails")}</summary>
            <p className="m-0 mt-1 whitespace-pre-wrap break-words font-mono">{status.lastError}</p>
          </details>
        )}
      </div>
    </section>
  );
}
