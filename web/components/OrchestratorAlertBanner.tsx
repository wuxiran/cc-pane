import { AlertTriangle, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import AlertBannerShell, {
  alertBannerDescClass,
  alertBannerTitleClass,
} from "@/components/layout/AlertBannerShell";
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
    <AlertBannerShell
      tone={failed ? "danger" : "warning"}
      role={failed ? "alert" : "status"}
      ariaLive={failed ? "assertive" : "polite"}
      icon={
        <Icon className={`size-3.5 ${failed ? "" : "animate-spin"}`} strokeWidth={1.6} />
      }
    >
      <p className={alertBannerTitleClass}>
        {failed
          ? t("orchestratorAlert.failedTitle")
          : retryTime
            ? t("orchestratorAlert.retrying", {
                attempt: status.attempt,
                time: retryTime,
              })
            : t("orchestratorAlert.attempting", { attempt: status.attempt })}
      </p>
      <p className={alertBannerDescClass}>
        {t("orchestratorAlert.impact")} {t("orchestratorAlert.escapePrefix")}{" "}
        <code className="font-mono text-[var(--app-text-primary)]">CC_PANES_ORCHESTRATOR_PORT</code>{" "}
        {t("orchestratorAlert.escapeSuffix")}
      </p>
      {failed && status.lastError && (
        <details className="mt-1 text-[11px] text-[var(--app-text-secondary)]">
          <summary className="w-fit cursor-pointer rounded-sm transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:text-[var(--app-text-primary)]">
            {t("orchestratorAlert.errorDetails")}
          </summary>
          <p className="m-0 mt-1 whitespace-pre-wrap break-words font-mono">{status.lastError}</p>
        </details>
      )}
    </AlertBannerShell>
  );
}
