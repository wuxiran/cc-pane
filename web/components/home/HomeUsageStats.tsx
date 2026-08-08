import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  BarChart3,
  ChevronDown,
  Database,
  Gauge,
  Layers3,
  RefreshCw,
  Zap,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUsageStatsStore, useWorkspacesStore } from "@/stores";
import { waitForTauri } from "@/utils";
import type { UsageTotals } from "@/types/usageStats";

type RangeKey = "today" | "24h" | "7d" | "30d" | "90d";

const RANGE_OPTIONS = [
  { key: "today", days: 1, labelKey: "usage.rangeToday" },
  { key: "24h", days: 2, labelKey: "usage.range24h" },
  { key: "7d", days: 7, labelKey: "usage.range7d" },
  { key: "30d", days: 30, labelKey: "usage.range30d" },
  { key: "90d", days: 90, labelKey: "usage.range90d" },
] as const satisfies ReadonlyArray<{ key: RangeKey; days: number; labelKey: string }>;

const GLOBAL_WORKSPACE = "_global";

function emptyTotals(): UsageTotals {
  return {
    charCount: 0,
    tokenInput: 0,
    tokenOutput: 0,
    tokenCacheRead: 0,
    tokenCacheCreation: 0,
  };
}

function addTotals(target: UsageTotals, source: UsageTotals): UsageTotals {
  return {
    charCount: target.charCount + source.charCount,
    tokenInput: target.tokenInput + source.tokenInput,
    tokenOutput: target.tokenOutput + source.tokenOutput,
    tokenCacheRead: target.tokenCacheRead + source.tokenCacheRead,
    tokenCacheCreation: target.tokenCacheCreation + source.tokenCacheCreation,
  };
}

function intlLocale(language: string): string {
  return language.startsWith("zh") ? "zh-CN" : "en-US";
}

function formatNumber(value: number, language: string): string {
  return new Intl.NumberFormat(intlLocale(language), { maximumFractionDigits: 0 }).format(value);
}

function formatCompact(value: number, language: string): string {
  return new Intl.NumberFormat(intlLocale(language), {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatPercent(value: number | null): string {
  return value === null || Number.isNaN(value) ? "--" : `${(value * 100).toFixed(1)}%`;
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

function tokenTotal(totals: UsageTotals | undefined): number {
  if (!totals) return 0;
  return totals.tokenInput + totals.tokenOutput + totals.tokenCacheRead + totals.tokenCacheCreation;
}

function hitRate(totals: UsageTotals | undefined): number | null {
  if (!totals) return null;
  const cacheableInput = totals.tokenInput + totals.tokenCacheRead + totals.tokenCacheCreation;
  return cacheableInput > 0 ? totals.tokenCacheRead / cacheableInput : null;
}

function rangeKeyToDays(key: RangeKey): number {
  return RANGE_OPTIONS.find((option) => option.key === key)?.days ?? 30;
}

function daysToInitialRangeKey(days: number): RangeKey {
  return RANGE_OPTIONS.find((option) => option.days === days)?.key ?? "30d";
}

function formatDateLabel(value: string, language: string): string {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(intlLocale(language), {
    month: language.startsWith("zh") ? "numeric" : "short",
    day: "numeric",
  }).format(date);
}

export default function HomeUsageStats() {
  const { t, i18n } = useTranslation("home");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const {
    rangeDays,
    workspaceFilter,
    data,
    loading,
    refreshing,
    error,
    load,
    refresh,
    setRangeDays,
    setWorkspaceFilter,
  } = useUsageStatsStore();
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const loadWorkspaces = useWorkspacesStore((state) => state.load);
  const [rangeKey, setRangeKey] = useState<RangeKey>(() => daysToInitialRangeKey(rangeDays));
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    waitForTauri().then(async (ready) => {
      if (cancelled || !ready) return;
      await load().catch(() => undefined);
      if (workspaces.length === 0) await loadWorkspaces().catch(() => undefined);
    });
    return () => {
      cancelled = true;
    };
  }, [load, loadWorkspaces, workspaces.length]);

  const handleRangeKeyChange = useCallback(async (key: RangeKey) => {
    setRangeKey(key);
    await setRangeDays(rangeKeyToDays(key));
  }, [setRangeDays]);

  const workspaceOptions = useMemo(() => {
    const names = new Set<string>();
    for (const workspace of workspaces) names.add(workspace.name);
    for (const workspace of data?.workspaces ?? []) names.add(workspace);
    return [...names].sort((a, b) => {
      if (a === GLOBAL_WORKSPACE) return -1;
      if (b === GLOBAL_WORKSPACE) return 1;
      return a.localeCompare(b);
    });
  }, [data?.workspaces, workspaces]);

  const availableClis = useMemo(() => Object.entries(data?.byCli ?? {})
    .filter(([, totals]) => tokenTotal(totals) > 0)
    .map(([cli]) => cli)
    .sort((a, b) => cliLabel(a).localeCompare(cliLabel(b))), [data?.byCli]);

  const activeClis = useMemo(() => sourceFilter === null
    ? availableClis
    : availableClis.filter((cli) => cli === sourceFilter), [availableClis, sourceFilter]);

  const chartData = useMemo(() => (data?.series ?? []).map((point) => {
    const totals = Object.entries(point.byCli ?? {})
      .filter(([cli]) => sourceFilter === null || cli === sourceFilter)
      .map(([, cliTotals]) => cliTotals)
      .reduce(addTotals, emptyTotals());
    return {
      date: point.date,
      input: totals.tokenInput,
      output: totals.tokenOutput,
      cacheCreation: totals.tokenCacheCreation,
      cacheRead: totals.tokenCacheRead,
    };
  }), [data?.series, sourceFilter]);

  const totals = useMemo(() => Object.entries(data?.byCli ?? {})
    .filter(([cli]) => sourceFilter === null || cli === sourceFilter)
    .map(([, cliTotals]) => cliTotals)
    .reduce(addTotals, emptyTotals()), [data?.byCli, sourceFilter]);
  const totalTokens = tokenTotal(totals);
  const hasData = chartData.length > 0 && totalTokens > 0;
  const currentWorkspaceLabel = workspaceFilter === null
    ? t("usage.allWorkspaces")
    : workspaceFilter === GLOBAL_WORKSPACE
      ? t("usage.unmatchedSessions")
      : workspaceFilter;
  const currentSourceLabel = sourceFilter === null ? t("usage.allSources") : cliLabel(sourceFilter);

  const metricItems = [
    { key: "input", label: t("usage.freshInput"), value: totals?.tokenInput ?? 0, icon: ArrowDownToLine, color: "var(--chart-2)" },
    { key: "output", label: t("usage.totalOutputTokens"), value: totals?.tokenOutput ?? 0, icon: ArrowUpFromLine, color: "var(--chart-3)" },
    { key: "creation", label: t("usage.cacheCreation"), value: totals?.tokenCacheCreation ?? 0, icon: Database, color: "var(--chart-3)" },
    { key: "hit", label: t("usage.cacheRead"), value: totals?.tokenCacheRead ?? 0, icon: Layers3, color: "var(--chart-4)" },
  ];
  const activeRangeOption = RANGE_OPTIONS.find((option) => option.key === rangeKey) ?? RANGE_OPTIONS[3];
  const activeRangeLabel = t(activeRangeOption.labelKey);

  return (
    <section className="space-y-5" aria-label={t("usage.title")}>
      <header className="flex items-center justify-between gap-4 border-b pb-4" style={{ borderColor: "var(--app-home-border)" }}>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-[18px] w-[18px]" style={{ color: "var(--app-accent)" }} />
            <h2 className="text-lg font-semibold" style={{ color: "var(--app-text-primary)" }}>{t("usage.title")}</h2>
          </div>
          <p className="mt-1 max-w-[280px] text-[13px]" style={{ color: "var(--app-text-secondary)" }}>{t("usage.subtitle")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="inline-flex h-8 w-[104px] shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[12px]" style={{ background: "var(--app-home-surface)", borderColor: "var(--app-home-border)", color: "var(--app-text-primary)" }}>
                <span className="min-w-0 flex-1 truncate">{currentSourceLabel}</span>
                <ChevronDown className="h-3.5 w-3.5 opacity-60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[160px]">
              <DropdownMenuItem onSelect={() => setSourceFilter(null)}>{t("usage.allSources")}</DropdownMenuItem>
              {availableClis.map((cli) => (
                <DropdownMenuItem key={cli} onSelect={() => setSourceFilter(cli)}>{cliLabel(cli)}</DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="inline-flex h-8 w-[130px] shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[12px]" style={{ background: "var(--app-home-surface)", borderColor: "var(--app-home-border)", color: "var(--app-text-primary)" }}>
                <span className="min-w-0 flex-1 truncate">{currentWorkspaceLabel}</span>
                <ChevronDown className="h-3.5 w-3.5 opacity-60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-[320px] min-w-[200px] overflow-y-auto">
              <DropdownMenuItem onSelect={() => void setWorkspaceFilter(null)}>{t("usage.allWorkspaces")}</DropdownMenuItem>
              {workspaceOptions.map((name) => (
                <DropdownMenuItem key={name} onSelect={() => void setWorkspaceFilter(name)}>
                  {name === GLOBAL_WORKSPACE ? t("usage.unmatchedSessions") : name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="inline-flex h-8 shrink-0 overflow-hidden rounded-md border" style={{ borderColor: "var(--app-home-border)" }}>
            {RANGE_OPTIONS.map((option) => {
              const active = rangeKey === option.key;
              return (
                <button key={option.key} type="button" className="min-w-9 shrink-0 whitespace-nowrap px-1.5 text-[12px] transition-colors" style={{ background: active ? "var(--app-accent)" : "var(--app-home-surface)", color: active ? "var(--primary-foreground)" : "var(--app-text-secondary)" }} onClick={() => void handleRangeKeyChange(option.key)}>
                  {t(option.labelKey)}
                </button>
              );
            })}
          </div>
          <button type="button" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors hover:bg-[var(--app-home-surface-hover)]" style={{ borderColor: "var(--app-home-border)", color: "var(--app-text-secondary)" }} onClick={() => void refresh()} disabled={refreshing} title={t("usage.refresh")}>
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          </button>
        </div>
      </header>

      {error ? (
        <div className="flex h-[280px] items-center justify-center text-sm" style={{ color: "var(--destructive)" }}>{error}</div>
      ) : loading && !data ? (
        <div className="flex h-[280px] items-center justify-center text-sm" style={{ color: "var(--app-text-tertiary)" }}>{t("usage.loading")}</div>
      ) : !hasData ? (
        <div className="flex h-[160px] items-center justify-center text-sm" style={{ color: "var(--app-text-tertiary)" }}>{t("usage.noData")}</div>
      ) : (
        <div className="space-y-4">
          <section className="overflow-hidden rounded-lg border" style={{ background: "var(--app-home-surface)", borderColor: "var(--app-home-border)" }}>
            <div className="flex flex-col gap-3 px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg" style={{ background: "color-mix(in srgb, var(--app-accent) 16%, transparent)", color: "var(--app-accent)" }}>
                  <Zap className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <div className="text-[13px] font-medium" style={{ color: "var(--app-text-secondary)" }}>{t("usage.processedTokens")}</div>
                  <div className="mt-1 flex items-baseline gap-2">
                    <strong className="truncate text-2xl font-semibold tabular-nums" style={{ color: "var(--app-text-primary)" }} title={formatNumber(totalTokens, language)}>{formatCompact(totalTokens, language)}</strong>
                    <span className="text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("usage.tokensUnit")}</span>
                  </div>
                </div>
              </div>
              <div className="flex divide-x rounded-lg border" style={{ borderColor: "var(--app-home-row-border)" }}>
                <div className="px-3 py-2">
                  <div className="text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("usage.activeSources")}</div>
                  <div className="mt-1 text-base font-semibold tabular-nums" style={{ color: "var(--app-text-primary)" }}>{activeClis.length}</div>
                </div>
                <div className="px-3 py-2">
                  <div className="text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("usage.currentRange")}</div>
                  <div className="mt-1 text-base font-semibold" style={{ color: "var(--app-text-primary)" }}>{activeRangeLabel}</div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 border-t sm:grid-cols-2 lg:grid-cols-3" style={{ borderColor: "var(--app-home-row-border)" }}>
              {metricItems.map((item) => {
                const Icon = item.icon;
                return (
                  <div key={item.key} className="min-w-0 border-b px-4 py-3 sm:border-r last:border-r-0" style={{ borderColor: "var(--app-home-row-border)" }}>
                    <div className="flex items-center gap-2 text-[12px] font-medium" style={{ color: "var(--app-text-secondary)" }}>
                      <Icon className="h-3.5 w-3.5" style={{ color: item.color }} />
                      {item.label}
                    </div>
                    <div className="mt-1.5 truncate text-base font-semibold tabular-nums" style={{ color: "var(--app-text-primary)" }} title={formatNumber(item.value, language)}>{formatCompact(item.value, language)}</div>
                  </div>
                );
              })}
              <div className="min-w-0 px-4 py-3 sm:col-span-2 lg:col-span-2">
                <div className="flex items-center justify-between gap-3 text-[12px] font-medium" style={{ color: "var(--app-text-secondary)" }}>
                  <span className="flex items-center gap-2"><Gauge className="h-3.5 w-3.5" style={{ color: "var(--chart-2)" }} />{t("usage.cacheHitRate")}</span>
                  <span className="tabular-nums" style={{ color: "var(--chart-2)" }}>{formatPercent(hitRate(totals))}</span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: "var(--app-home-row-border)" }}>
                  <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(1, hitRate(totals) ?? 0)) * 100}%`, background: "var(--chart-2)" }} />
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-lg border p-4" style={{ background: "var(--app-home-surface)", borderColor: "var(--app-home-border)" }}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-[15px] font-semibold" style={{ color: "var(--app-text-primary)" }}>{t("usage.tokenChartTitle")}</h3>
                <p className="mt-1 text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("usage.trendDescription")}</p>
              </div>
              <span className="text-sm" style={{ color: "var(--app-text-secondary)" }}>{activeRangeLabel}</span>
            </div>
            <div className="h-[260px] min-w-0">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 12, right: 14, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="usage-cache-read" x1="0" x2="0" y1="0" y2="1">
                      <stop offset="0%" stopColor="var(--chart-4)" stopOpacity={0.28} />
                      <stop offset="100%" stopColor="var(--chart-4)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="var(--app-home-row-border)" strokeDasharray="3 4" vertical={false} />
                  <XAxis dataKey="date" tick={{ fill: "var(--app-text-tertiary)", fontSize: 11 }} tickFormatter={(value) => formatDateLabel(String(value), language)} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fill: "var(--app-text-tertiary)", fontSize: 11 }} tickFormatter={(value) => formatCompact(Number(value) || 0, language)} width={62} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(value, name) => [formatNumber(Number(value) || 0, language), String(name ?? "")]} contentStyle={{ background: "var(--app-home-surface)", border: "1px solid var(--app-home-border)", borderRadius: 8, color: "var(--app-text-primary)", fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 12, paddingTop: 14 }} />
                  <Area type="monotone" dataKey="cacheRead" name={t("usage.cacheRead")} stroke="var(--chart-4)" strokeWidth={2.25} fill="url(#usage-cache-read)" dot={chartData.length === 1} />
                  <Line type="monotone" dataKey="cacheCreation" name={t("usage.cacheCreation")} stroke="var(--chart-3)" strokeWidth={2} dot={chartData.length === 1} />
                  <Line type="monotone" dataKey="input" name={t("usage.freshInput")} stroke="var(--chart-2)" strokeWidth={2} dot={chartData.length === 1} />
                  <Line type="monotone" dataKey="output" name={t("usage.totalOutputTokens")} stroke="var(--chart-2)" strokeWidth={2} dot={chartData.length === 1} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-4 flex flex-wrap gap-2 border-t pt-4" style={{ borderColor: "var(--app-home-row-border)" }}>
              {activeClis.map((cli) => (
                <span key={cli} className="inline-flex h-7 items-center rounded-md border px-2.5 text-xs" style={{ borderColor: "var(--app-home-row-border)", color: "var(--app-text-secondary)" }}>
                  {cliLabel(cli)} <span className="ml-1.5 tabular-nums" style={{ color: "var(--app-text-primary)" }}>{formatCompact(tokenTotal(data?.byCli[cli]), language)}</span>
                </span>
              ))}
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
