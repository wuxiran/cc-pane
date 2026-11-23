// 状态栏用量弹窗的报表主体：总处理量 + 三项关键指标、Token 构成条、每日趋势、按来源明细。
// 计算全部在 usageReport.ts，这里只负责排版。
import { useTranslation } from "react-i18next";
import type { UsageReport } from "./usageReport";

const SECTION_LABEL = "mb-1.5 text-[length:var(--text-micro)] font-medium text-[var(--app-text-tertiary)]";

export function formatCompact(value: number, language: string): string {
  return new Intl.NumberFormat(language.startsWith("zh") ? "zh-CN" : "en-US", {
    notation: "compact",
    maximumFractionDigits: value >= 1000 && value < 10000 ? 1 : 0,
  }).format(value);
}

export function formatPercent(value: number | null): string {
  return value === null || Number.isNaN(value) ? "--" : `${(value * 100).toFixed(1)}%`;
}

function formatFull(value: number, language: string): string {
  return new Intl.NumberFormat(language.startsWith("zh") ? "zh-CN" : "en-US").format(value);
}

export default function UsageStatsReport({
  report,
  sourceLabel,
  showSources,
}: {
  report: UsageReport;
  sourceLabel: (source: string) => string;
  showSources: boolean;
}) {
  const { t, i18n } = useTranslation("home");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const { totals } = report;

  const composition = [
    { key: "fresh", label: t("usage.freshInput"), value: totals.tokenInput, color: "var(--chart-1)" },
    { key: "creation", label: t("usage.cacheCreation"), value: totals.tokenCacheCreation, color: "var(--chart-4)" },
    { key: "read", label: t("usage.cacheRead"), value: totals.tokenCacheRead, color: "var(--chart-2)" },
    { key: "output", label: t("usage.previewOutput"), value: totals.tokenOutput, color: "var(--chart-3)" },
  ];
  const peak = Math.max(1, ...report.days.map((day) => day.processed));

  return (
    <div className="flex flex-col gap-3">
      {/* 总处理量 + 关键指标 */}
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[length:var(--text-micro)] text-[var(--app-text-tertiary)]">{t("usage.processedTokens")}</div>
          <div
            className="truncate text-[22px] font-semibold leading-tight tabular-nums text-[var(--app-text-primary)]"
            title={formatFull(report.processed, language)}
          >
            {formatCompact(report.processed, language)}
          </div>
        </div>
        <dl className="flex shrink-0 gap-4 text-right">
          {[
            { label: t("usage.previewInput"), value: formatCompact(totals.tokenInput, language), color: "var(--chart-1)" },
            { label: t("usage.previewOutput"), value: formatCompact(totals.tokenOutput, language), color: "var(--chart-3)" },
            { label: t("usage.previewHitRate"), value: formatPercent(report.hitRate), color: "var(--chart-2)" },
          ].map((metric) => (
            <div key={metric.label} className="min-w-0">
              <dt className="text-[length:var(--text-micro)] text-[var(--app-text-tertiary)]">{metric.label}</dt>
              <dd className="m-0 text-[length:var(--text-row)] font-semibold tabular-nums" style={{ color: metric.color }}>
                {metric.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      {/* Token 构成：一条堆叠条 + 四项图例 */}
      <section aria-label={t("usage.previewComposition")}>
        <div className={SECTION_LABEL}>{t("usage.previewComposition")}</div>
        <div className="flex h-2 overflow-hidden rounded-full bg-[var(--app-home-row-border)]">
          {report.processed > 0 && composition.map((part) => (
            <div
              key={part.key}
              className="h-full"
              style={{ width: `${(part.value / report.processed) * 100}%`, background: part.color }}
              title={`${part.label} ${formatFull(part.value, language)}`}
            />
          ))}
        </div>
        <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-0.5">
          {composition.map((part) => (
            <div key={part.key} className="flex min-w-0 items-center gap-1.5 text-[length:var(--text-micro)]">
              <span className="size-2 shrink-0 rounded-sm" style={{ background: part.color }} aria-hidden="true" />
              <span className="truncate text-[var(--app-text-secondary)]">{part.label}</span>
              <span className="ml-auto tabular-nums text-[var(--app-text-primary)]" title={formatFull(part.value, language)}>
                {formatCompact(part.value, language)}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* 每日趋势：范围只有一天时没有可比的点，不画 */}
      {report.days.length > 1 && (
        <section aria-label={t("usage.previewTrend")}>
          <div className={SECTION_LABEL}>{t("usage.previewTrend")}</div>
          <div className="flex h-12 items-end gap-px" data-testid="usage-preview-trend">
            {report.days.map((day) => (
              <div
                key={day.date}
                className="min-w-0 flex-1 rounded-t-sm transition-opacity hover:opacity-80"
                style={{
                  height: `${Math.max(day.processed > 0 ? 6 : 2, (day.processed / peak) * 100)}%`,
                  background: day.processed > 0 ? "var(--app-accent)" : "var(--app-home-row-border)",
                }}
                title={`${day.date} · ${formatFull(day.processed, language)}`}
              />
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[length:var(--text-nano)] tabular-nums text-[var(--app-text-tertiary)]">
            <span>{report.days[0].date.slice(5)}</span>
            <span>{report.days[report.days.length - 1].date.slice(5)}</span>
          </div>
        </section>
      )}

      {/* 按来源：只在「全部来源」时列，选了单个来源再列一遍没有意义 */}
      {showSources && report.sources.length > 0 && (
        <section aria-label={t("usage.previewBySource")}>
          <div className={SECTION_LABEL}>{t("usage.previewBySource")}</div>
          <div className="flex flex-col gap-1">
            {report.sources.slice(0, 6).map((row) => (
              <div key={row.source} className="grid grid-cols-[72px_1fr_52px_44px] items-center gap-2 text-[length:var(--text-micro)]">
                <span className="truncate text-[var(--app-text-secondary)]">{sourceLabel(row.source)}</span>
                <span className="h-1.5 overflow-hidden rounded-full bg-[var(--app-home-row-border)]">
                  <span className="block h-full rounded-full bg-[var(--app-accent)]" style={{ width: `${row.share * 100}%` }} />
                </span>
                <span className="text-right tabular-nums text-[var(--app-text-primary)]" title={formatFull(row.processed, language)}>
                  {formatCompact(row.processed, language)}
                </span>
                <span className="text-right tabular-nums text-[var(--app-text-tertiary)]" title={t("usage.previewHitRate")}>
                  {formatPercent(row.hitRate)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
