import { useEffect, useState } from "react";
import { BarChart3, ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { navigateToSettings } from "@/components/settings/settingsNavigation";
import { useUsageStatsStore } from "@/stores";
import UsageStatsReport from "./UsageStatsReport";
import { buildUsageReport } from "./usageReport";

const PREVIEW_RANGES = [
  { days: 1, labelKey: "usage.rangeToday" },
  { days: 7, labelKey: "usage.range7d" },
  { days: 30, labelKey: "usage.range30d" },
] as const;

interface UsageStatsHoverPreviewProps {
  open: boolean;
  onSourceMenuOpenChange?: (open: boolean) => void;
}

function cliLabel(cli: string): string {
  const labels: Record<string, string> = {
    claude: "Claude",
    codex: "Codex",
    pi: "Pi",
    gemini: "Gemini",
    opencode: "OpenCode",
    grokbuild: "Grok Build",
  };
  return labels[cli] ?? cli;
}

export default function UsageStatsHoverPreview({
  open,
  onSourceMenuOpenChange,
}: UsageStatsHoverPreviewProps) {
  const { t } = useTranslation("home");
  const { data, loading, load, rangeDays, setRangeDays } = useUsageStatsStore();
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);

  useEffect(() => {
    if (open && !data && !loading) {
      void load().catch(() => undefined);
    }
  }, [data, load, loading, open]);

  const availableSources = Object.entries(data?.byCli ?? {})
    .filter(([, totals]) => totals.tokenInput + totals.tokenOutput + totals.tokenCacheRead + totals.tokenCacheCreation > 0)
    .map(([source]) => source)
    .sort((left, right) => cliLabel(left).localeCompare(cliLabel(right)));

  if (!open) return null;

  const report = buildUsageReport(data, sourceFilter);

  return (
    <section
      id="usage-stats-hover-preview"
      data-testid="usage-stats-hover-preview"
      aria-label={t("usage.title")}
      className="absolute bottom-[calc(100%+8px)] right-0 z-50 w-[400px] max-w-[calc(100vw-16px)] rounded-lg border p-3 shadow-xl"
      style={{
        background: "var(--app-home-surface)",
        borderColor: "var(--app-home-border)",
        color: "var(--app-text-primary)",
      }}
    >
      <header
        className="mb-3 flex h-6 items-center justify-between gap-2 border-b pb-2"
        style={{ borderColor: "var(--app-home-border)" }}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="flex shrink-0 items-center gap-1 text-[length:var(--text-small)] font-semibold">
            <BarChart3 className="h-3 w-3" style={{ color: "var(--app-accent)" }} />
            {t("usage.title")}
          </span>
          <DropdownMenu onOpenChange={onSourceMenuOpenChange}>
            <DropdownMenuTrigger asChild>
              <button type="button" className="inline-flex h-4.5 max-w-[86px] items-center gap-0.5 truncate rounded px-1 text-[length:var(--text-nano)] hover:bg-[var(--app-hover)]" style={{ color: "var(--app-text-secondary)" }}>
                <span className="truncate">{sourceFilter === null ? t("usage.allSources") : cliLabel(sourceFilter)}</span>
                <ChevronDown className="h-2.5 w-2.5 shrink-0" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[104px] p-0.5">
              <DropdownMenuItem className="px-2 py-1 text-[length:var(--text-small)]" onSelect={() => setSourceFilter(null)}>{t("usage.allSources")}</DropdownMenuItem>
              {availableSources.map((source) => (
                <DropdownMenuItem className="px-2 py-1 text-[length:var(--text-small)]" key={source} onSelect={() => setSourceFilter(source)}>{cliLabel(source)}</DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="ml-auto flex shrink-0 items-center rounded-md bg-[var(--app-hover)] p-0.5" role="group" aria-label={t("usage.timeRange")}>
          {PREVIEW_RANGES.map((range) => (
            <button
              key={range.days}
              type="button"
              aria-pressed={rangeDays === range.days}
              className={`rounded px-1.5 text-[length:var(--text-nano)] leading-[18px] transition-colors ${
                rangeDays === range.days
                  ? "bg-[var(--app-active-bg)] text-[var(--app-text-primary)]"
                  : "text-[var(--app-text-tertiary)] hover:text-[var(--app-text-primary)]"
              }`}
              onClick={() => void setRangeDays(range.days).catch(() => undefined)}
            >
              {t(range.labelKey)}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="inline-flex shrink-0 items-center text-[length:var(--text-micro)] transition-colors hover:text-[var(--app-text-primary)]"
          style={{ color: "var(--app-text-secondary)" }}
          onClick={() => navigateToSettings({ paneId: "usage-stats" })}
        >
          {t("usage.previewMore")}
          <ChevronRight className="h-3 w-3" aria-hidden="true" />
        </button>
      </header>

      {loading && !data ? (
        <div className="flex h-[120px] items-center justify-center text-[length:var(--text-caption)] text-[var(--app-text-tertiary)]">
          {t("usage.loading")}
        </div>
      ) : report.processed === 0 ? (
        <div className="flex h-[80px] items-center justify-center text-[length:var(--text-caption)] text-[var(--app-text-tertiary)]">
          {t("usage.noData")}
        </div>
      ) : (
        <UsageStatsReport report={report} sourceLabel={cliLabel} showSources={sourceFilter === null} />
      )}
    </section>
  );
}
