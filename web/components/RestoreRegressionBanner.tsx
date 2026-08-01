import { AlertTriangle, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useRestoreReportStore } from "@/stores/useRestoreReportStore";
import { isRestoreRegression } from "@/utils/restoreReport";

/**
 * 「本应恢复的 agent leaf 丢失 resume id」时的可见告警。
 *
 * 形态刻意与 `OrchestratorAlertBanner` 一致（AppShell 顶部条、status token 配色、
 * 非模态），避免为一条告警新造设计语言。
 *
 * 为什么值得占一条横幅：resume id 落库链断掉后，表现只是「恢复出来的会话没有历史
 * 对话」——功能都在、没有任何报错，用户只会觉得是自己记错了。实测连续三天 100%
 * 未绑定无人发现（docs/69）。这条横幅是那次事故的回归防线。
 */
export default function RestoreRegressionBanner() {
  const { t } = useTranslation("panes");
  const summary = useRestoreReportStore((s) => s.summary);
  const dismissed = useRestoreReportStore((s) => s.dismissed);
  const dismiss = useRestoreReportStore((s) => s.dismiss);

  if (dismissed || !summary || !isRestoreRegression(summary)) return null;

  return (
    <section
      role="alert"
      aria-live="polite"
      className="relative z-[2] flex shrink-0 items-start gap-2.5 border-y px-3 py-2 text-xs"
      style={{
        borderColor: "var(--app-status-warning-border)",
        background: "var(--app-status-warning-bg)",
        color: "var(--app-status-warning)",
      }}
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="m-0 font-medium">
          {t("restoreRegression.title", { count: summary.missingResumeId })}
        </p>
        <p className="m-0 mt-0.5 text-[11px] text-[var(--app-text-secondary)]">
          {t("restoreRegression.impact")}
        </p>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t("restoreRegression.dismiss")}
        className="shrink-0 rounded p-0.5 opacity-70 transition-opacity hover:opacity-100"
      >
        <X className="size-3.5" />
      </button>
    </section>
  );
}
