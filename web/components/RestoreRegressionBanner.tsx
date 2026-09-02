import { AlertTriangle, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import AlertBannerShell, {
  alertBannerCloseButtonClass,
  alertBannerDescClass,
  alertBannerTitleClass,
} from "@/components/layout/AlertBannerShell";
import { useRestoreReportStore } from "@/stores/useRestoreReportStore";
import { isRestoreRegression } from "@/utils/restoreReport";

/**
 * 「本应恢复的 agent leaf 丢失 resume id」时的可见告警。
 *
 * 形态与 `OrchestratorAlertBanner` 共用 `AlertBannerShell`（AppShell 顶部条、
 * status token 配色、非模态），避免为一条告警新造设计语言。
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
    <AlertBannerShell
      tone="warning"
      role="alert"
      ariaLive="polite"
      icon={<AlertTriangle className="size-3.5" strokeWidth={1.6} />}
      action={
        <button
          type="button"
          onClick={dismiss}
          aria-label={t("restoreRegression.dismiss")}
          className={alertBannerCloseButtonClass}
        >
          <X className="size-3.5" strokeWidth={1.6} />
        </button>
      }
    >
      <p className={alertBannerTitleClass}>
        {t("restoreRegression.title", { count: summary.missingResumeId })}
      </p>
      <p className={alertBannerDescClass}>{t("restoreRegression.impact")}</p>
    </AlertBannerShell>
  );
}
