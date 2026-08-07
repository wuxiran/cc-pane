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
import type { UsageTotals } from "@/types/usageStats";

interface UsageStatsHoverPreviewProps {
  open: boolean;
  onSourceMenuOpenChange?: (open: boolean) => void;
}

function cliLabel(cli: string): string {
  const labels: Record<string, string> = {
    claude: "Claude",
    codex: "Codex",
    gemini: "Gemini",
    opencode: "OpenCode",
    grokbuild: "Grok Build",
  };
  return labels[cli] ?? cli;
}

function formatCompact(value: number, language: string): string {
  return new Intl.NumberFormat(language.startsWith("zh") ? "zh-CN" : "en-US", {
    notation: "compact",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatPercent(value: number | null): string {
  return value === null || Number.isNaN(value)
    ? "--"
    : `${(value * 100).toFixed(1)}%`;
}

export default function UsageStatsHoverPreview({
  open,
  onSourceMenuOpenChange,
}: UsageStatsHoverPreviewProps) {
  const { t, i18n } = useTranslation("home");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const { data, loading, load } = useUsageStatsStore();
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

  const totals = Object.entries(data?.byCli ?? {})
    .filter(([source]) => sourceFilter === null || source === sourceFilter)
    .map(([, value]) => value)
    .reduce<UsageTotals>(
      (sum, current) => ({
        charCount: sum.charCount + current.charCount,
        tokenInput: sum.tokenInput + current.tokenInput,
        tokenOutput: sum.tokenOutput + current.tokenOutput,
        tokenCacheRead: sum.tokenCacheRead + current.tokenCacheRead,
        tokenCacheCreation: sum.tokenCacheCreation + current.tokenCacheCreation,
      }),
      { charCount: 0, tokenInput: 0, tokenOutput: 0, tokenCacheRead: 0, tokenCacheCreation: 0 },
    );
  const input = totals.tokenInput;
  const output = totals.tokenOutput;
  const cacheableInput = totals.tokenInput + totals.tokenCacheCreation + totals.tokenCacheRead;
  const hitRate = cacheableInput > 0 ? totals.tokenCacheRead / cacheableInput : null;
  const metrics = [
    {
      label: t("usage.previewInput"),
      value: formatCompact(input, language),
      color: "var(--chart-2)",
    },
    {
      label: t("usage.previewOutput"),
      value: formatCompact(output, language),
      color: "var(--chart-1)",
    },
    {
      label: t("usage.previewHitRate"),
      value: formatPercent(hitRate),
      color: "var(--chart-3)",
    },
  ];

  return (
    <section
      data-testid="usage-stats-hover-preview"
      aria-label={t("usage.title")}
      className="absolute bottom-[calc(100%+8px)] right-0 z-50 w-[292px] rounded-md border p-2.5 shadow-xl"
      style={{
        background: "var(--app-home-surface)",
        borderColor: "var(--app-home-border)",
        color: "var(--app-text-primary)",
      }}
    >
      <header
        className="mb-1.5 flex h-5 items-center justify-between gap-2 border-b pb-1.5"
        style={{ borderColor: "var(--app-home-border)" }}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="flex shrink-0 items-center gap-1 text-[12px] font-semibold">
            <BarChart3 className="h-3 w-3" style={{ color: "var(--app-accent)" }} />
            {t("usage.title")}
          </span>
          <DropdownMenu onOpenChange={onSourceMenuOpenChange}>
            <DropdownMenuTrigger asChild>
              <button type="button" className="inline-flex h-4.5 max-w-[86px] items-center gap-0.5 truncate rounded px-1 text-[9px] hover:bg-[var(--app-hover)]" style={{ color: "var(--app-text-secondary)" }}>
                <span className="truncate">{sourceFilter === null ? t("usage.allSources") : cliLabel(sourceFilter)}</span>
                <ChevronDown className="h-2.5 w-2.5 shrink-0" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[104px] p-0.5">
              <DropdownMenuItem className="px-2 py-1 text-[12px]" onSelect={() => setSourceFilter(null)}>{t("usage.allSources")}</DropdownMenuItem>
              {availableSources.map((source) => (
                <DropdownMenuItem className="px-2 py-1 text-[12px]" key={source} onSelect={() => setSourceFilter(source)}>{cliLabel(source)}</DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <button
          type="button"
          className="inline-flex items-center text-[10px] transition-colors hover:text-[var(--app-text-primary)]"
          style={{ color: "var(--app-text-secondary)" }}
          onClick={() => navigateToSettings({ paneId: "usage-stats" })}
        >
          {t("usage.previewMore")}
          <ChevronRight className="h-3 w-3" aria-hidden="true" />
        </button>
      </header>

      {loading && !data ? (
        <div
          className="flex h-[58px] items-center justify-center text-[11px]"
          style={{ color: "var(--app-text-tertiary)" }}
        >
          {t("usage.loading")}
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-0">
          {metrics.map((metric) => (
            <div
              key={metric.label}
              className="min-w-0 px-2 first:pl-0 last:pr-0"
              style={{
                borderLeft: `1px solid ${metric === metrics[0] ? "transparent" : "var(--app-home-border)"}`,
              }}
            >
              <div
                className="truncate text-[10px]"
                style={{ color: "var(--app-text-secondary)" }}
              >
                {metric.label}
              </div>
              <div
                className="mt-0.5 truncate text-[15px] font-semibold tabular-nums"
                style={{ color: metric.color }}
                title={metric.value}
              >
                {metric.value}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
