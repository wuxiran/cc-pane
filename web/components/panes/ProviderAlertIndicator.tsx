// 状态栏上的供应商提醒（缓存命中率偏低 / 上次检测发现提示词注入）。只是小图标，不弹窗、不横幅。
import { Suspense, useState } from "react";
import { DatabaseZap, ShieldX } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ActiveTerminalContext } from "@/hooks/useActiveTerminalSession";
import { usePrivacyFeature } from "@/hooks/usePrivacyFeature";
import { lazyWithRetry } from "@/lib/lazyRetry";
import { useProviderAlerts } from "./providerAlerts";

const PurityDialog = lazyWithRetry(() => import("@/components/providers/PurityDialog"), "PurityDialog");

const TOOLTIP_CLASS = "w-[260px] space-y-1 rounded-sm border border-[var(--app-border)] bg-[var(--app-overlay)] px-2.5 py-2 text-left text-[11px] text-[var(--app-text-secondary)] shadow-lg text-pretty";

export default function ProviderAlertIndicator({ terminalContext }: { terminalContext: ActiveTerminalContext }) {
  const { t } = useTranslation("common");
  const alerts = useProviderAlerts(terminalContext);
  const purityEnabled = usePrivacyFeature("channelPurity");
  const [dialogOpen, setDialogOpen] = useState(false);
  if (!alerts || (!alerts.cacheLow && !alerts.injection)) return null;
  const { provider, cacheLow, injection } = alerts;

  return (
    <>
      {cacheLow ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              data-testid="provider-alert-cache"
              aria-label={t("providerAlert.cacheLowTitle")}
              className="flex shrink-0 items-center gap-0.5 tabular-nums"
              style={{ color: "var(--app-status-warning)" }}
            >
              <DatabaseZap className="size-3.5" aria-hidden="true" />
              {Math.round(cacheLow.ratio * 100)}%
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={8} className={TOOLTIP_CLASS}>
            <p className="font-semibold text-[var(--app-text-primary)]">{t("providerAlert.cacheLowTitle")}</p>
            <p>{t("providerAlert.cacheLowBody", { name: provider.name, ratio: Math.round(cacheLow.ratio * 100) })}</p>
            <p className="text-[var(--app-text-tertiary)]">{t("providerAlert.settingsHint")}</p>
          </TooltipContent>
        </Tooltip>
      ) : null}
      {injection ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-testid="provider-alert-injection"
              aria-label={t("providerAlert.injectionTitle")}
              disabled={!purityEnabled}
              className="flex shrink-0 items-center rounded p-0.5 enabled:hover:bg-[var(--app-hover)]"
              style={{ color: "var(--app-status-danger)" }}
              onClick={() => setDialogOpen(true)}
            >
              <ShieldX className="size-3.5" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={8} className={TOOLTIP_CLASS}>
            <p className="font-semibold text-[var(--app-text-primary)]">{t("providerAlert.injectionTitle")}</p>
            <p>{t("providerAlert.injectionBody", { name: provider.name, date: new Date(injection.checkedAt).toLocaleString() })}</p>
            <p className="text-[var(--app-text-tertiary)]">{t("providerAlert.settingsHint")}</p>
          </TooltipContent>
        </Tooltip>
      ) : null}
      {dialogOpen && purityEnabled ? (
        <Suspense fallback={null}>
          <PurityDialog provider={provider} accountId={alerts.accountId} onClose={() => setDialogOpen(false)} />
        </Suspense>
      ) : null}
    </>
  );
}
