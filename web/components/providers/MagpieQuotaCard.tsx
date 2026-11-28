import { useTranslation } from "react-i18next";
import type { MagpieQuota, MagpieQuotaWindow } from "@/types/magpie";
import type { Provider } from "@/types/provider";
import { formatPercent, rateLimitSeverity } from "@/utils/rateLimitDisplay";
import { magpieQuotaName, useMagpieQuotas } from "./magpieLive";

const MAX_ROWS = 6;

const SEVERITY_COLOR = {
  normal: "var(--app-text-tertiary)",
  warning: "var(--app-status-warning)",
  danger: "var(--app-status-danger)",
} as const;

function WindowChip({ window }: { window: MagpieQuotaWindow }) {
  const { t } = useTranslation("providers");
  if (window.unlimited) {
    return <span>{`${window.name} ${t("magpieQuota.unlimited")}`}</span>;
  }
  if (window.text) {
    return window.display ? <span>{`${window.name} ${window.display}`}</span> : null;
  }
  const resets = window.resetsAt ? new Date(window.resetsAt) : null;
  const title = resets && !Number.isNaN(resets.getTime())
    ? t("magpieQuota.resetsAt", { time: resets.toLocaleString() })
    : undefined;
  return (
    <span
      className="tabular-nums"
      title={title}
      style={{ color: SEVERITY_COLOR[rateLimitSeverity(window.used)] }}
    >
      {`${window.name} ${formatPercent(window.used)}`}
    </span>
  );
}

function QuotaRow({ quota }: { quota: MagpieQuota }) {
  const { t } = useTranslation("providers");
  return (
    <div className="flex min-w-0 items-center gap-1.5" data-testid="magpie-quota-row">
      <span className="truncate max-w-[180px]" style={{ color: "var(--app-text-secondary)" }} title={quota.user ?? undefined}>
        {magpieQuotaName(quota)}
        {quota.plan ? ` · ${quota.plan}` : ""}
        {quota.last ? ` ${t("magpieQuota.lastMark")}` : ""}
      </span>
      {quota.error ? (
        <span className="truncate" style={{ color: "var(--app-status-warning)" }} title={quota.error}>
          {t("magpieQuota.readFailed")}
        </span>
      ) : (
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
          {quota.windows.map((window) => <WindowChip key={window.name} window={window} />)}
          {quota.balance ? <span>{quota.balance}</span> : null}
        </span>
      )}
    </div>
  );
}

/**
 * 供应商视图里 Magpie 来源的供应商下方：Magpie 记下的额度（`/v1/magpie/quotas?kept=1`）。
 * Magpie 不在线、供应商不指向本机网关、没有额度数据时不渲染。
 */
export default function MagpieQuotaCard({ provider }: { provider: Provider }) {
  const { t } = useTranslation("providers");
  const report = useMagpieQuotas(provider);
  if (!report || report.quotas.length === 0) return null;
  const rows = report.quotas.slice(0, MAX_ROWS);
  const hidden = report.quotas.length - rows.length;
  return (
    <div
      data-testid="magpie-quota-card"
      className="mt-1 space-y-0.5 rounded-sm border border-[var(--app-border)] px-2 py-1 text-xs"
      style={{ color: "var(--app-text-tertiary)" }}
    >
      <div className="font-medium" style={{ color: "var(--app-text-secondary)" }}>{t("magpieQuota.title")}</div>
      {rows.map((quota, index) => (
        <QuotaRow key={`${quota.provider}-${quota.name}-${index}`} quota={quota} />
      ))}
      {hidden > 0 ? <div>{t("magpieQuota.more", { n: hidden })}</div> : null}
    </div>
  );
}
