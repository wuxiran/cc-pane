import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { BarChart3, ChevronDown, Cpu, Keyboard, RefreshCw, Sparkles } from "lucide-react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
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

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatPercent(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * 总 token 数公式按 CLI 区分（input_tokens 语义不同）：
 * - Claude: input_tokens 不含 cache_*，四项相加才是总量
 * - OpenAI/Codex: input_tokens 是 prompt 总数（已含 cache_read 子集），
 *   再叠加 cache_read 会把缓存读重复计一遍
 */
function tokenTotal(totals: UsageTotals | undefined, cli: "claude" | "codex"): number {
  if (!totals) return 0;
  if (cli === "codex") {
    return totals.tokenInput + totals.tokenOutput;
  }
  return (
    totals.tokenInput
    + totals.tokenOutput
    + totals.tokenCacheRead
    + totals.tokenCacheCreation
  );
}

/**
 * 缓存命中率公式按 CLI 区分（input_tokens 语义不同）：
 * - Claude: input_tokens 不含 cache_*；hit = cache_read / (input + cache_read + cache_creation)
 * - OpenAI/Codex: input_tokens 是 prompt 总数（已含 cache_read 子集）；hit = cache_read / input
 */
function hitRate(totals: UsageTotals | undefined, cli: "claude" | "codex"): number | null {
  if (!totals) return null;
  const denom = cli === "codex"
    ? totals.tokenInput
    : totals.tokenInput + totals.tokenCacheRead + totals.tokenCacheCreation;
  if (denom === 0) return null;
  return totals.tokenCacheRead / denom;
}

function rangeKeyToDays(key: RangeKey): number {
  return RANGE_OPTIONS.find((option) => option.key === key)?.days ?? 30;
}

function daysToInitialRangeKey(days: number): RangeKey {
  return RANGE_OPTIONS.find((option) => option.days === days)?.key ?? "30d";
}

export default function HomeUsageStats() {
  const { t } = useTranslation("home");
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
  const [hiddenTokenLines, setHiddenTokenLines] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    waitForTauri().then(async (ready) => {
      if (cancelled || !ready) return;
      await load().catch(() => undefined);
      if (workspaces.length === 0) {
        await loadWorkspaces().catch(() => undefined);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [load, loadWorkspaces, workspaces.length]);

  const handleRangeKeyChange = useCallback(
    async (key: RangeKey) => {
      setRangeKey(key);
      await setRangeDays(rangeKeyToDays(key));
    },
    [setRangeDays],
  );

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

  const chartData = useMemo(() => {
    return (data?.series ?? []).map((point) => {
      const claudeTokens = point.claudeTokensIn
        + point.claudeTokensOut
        + point.claudeCacheRead
        + point.claudeCacheCreation;
      // Codex 的 input 已含 cache_read 子集，不再叠加（见 tokenTotal 注释）
      const codexTokens = point.codexTokensIn + point.codexTokensOut;
      return {
        date: point.date,
        claudeTokens,
        codexTokens,
        totalChars: point.claudeChars + point.codexChars + point.unknownChars,
      };
    });
  }, [data?.series]);

  const totals = data?.totals;
  const claudeTokens = tokenTotal(data?.byCli.claude, "claude");
  const codexTokens = tokenTotal(data?.byCli.codex, "codex");
  const claudeHit = hitRate(data?.byCli.claude, "claude");
  const codexHit = hitRate(data?.byCli.codex, "codex");

  const showTrendCharts = rangeKey === "7d" || rangeKey === "30d" || rangeKey === "90d";
  const hasData = chartData.length > 0 && (totals?.charCount ?? 0) + claudeTokens + codexTokens > 0;

  const toggleHidden = (set: Set<string>, key: string): Set<string> => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  const currentWorkspaceLabel =
    workspaceFilter === null
      ? t("usage.allWorkspaces")
      : workspaceFilter === GLOBAL_WORKSPACE
        ? t("usage.unmatchedSessions")
        : workspaceFilter;

  return (
    <section>
      <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4" style={{ color: "var(--app-accent)" }} />
          <h3
            className="text-sm font-semibold"
            style={{ color: "var(--app-text-primary)" }}
          >
            {t("usage.title")}
          </h3>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs"
                style={{
                  background: "var(--app-home-surface)",
                  borderColor: "var(--app-home-border)",
                  color: "var(--app-text-primary)",
                }}
              >
                <span className="max-w-[160px] truncate">{currentWorkspaceLabel}</span>
                <ChevronDown className="h-3.5 w-3.5 opacity-60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[200px] max-h-[320px] overflow-y-auto">
              <DropdownMenuItem onSelect={() => void setWorkspaceFilter(null)}>
                {t("usage.allWorkspaces")}
              </DropdownMenuItem>
              {workspaceOptions.map((name) => (
                <DropdownMenuItem
                  key={name}
                  onSelect={() => void setWorkspaceFilter(name)}
                >
                  {name === GLOBAL_WORKSPACE ? t("usage.unmatchedSessions") : name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <div
            className="inline-flex h-8 overflow-hidden rounded-lg border"
            style={{ borderColor: "var(--app-home-border)" }}
          >
            {RANGE_OPTIONS.map((option) => {
              const active = rangeKey === option.key;
              return (
                <button
                  key={option.key}
                  className="px-2.5 text-xs transition-colors"
                  style={{
                    background: active ? "var(--app-accent)" : "var(--app-home-surface)",
                    color: active ? "var(--primary-foreground)" : "var(--app-text-secondary)",
                  }}
                  onClick={() => void handleRangeKeyChange(option.key)}
                >
                  {t(option.labelKey)}
                </button>
              );
            })}
          </div>

          <button
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors hover:bg-[var(--app-home-surface-hover)]"
            style={{
              borderColor: "var(--app-home-border)",
              color: "var(--app-text-secondary)",
            }}
            onClick={() => void refresh()}
            disabled={refreshing}
            title={t("usage.refresh")}
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-[var(--app-home-border)] bg-[var(--app-home-surface)] p-5">
        {/* 3 个 metric 卡片（带图标、命中率进度条） */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <MetricCard
            icon={<Keyboard className="h-4 w-4" />}
            label={t("usage.inputChars")}
            value={formatCompact(totals?.charCount ?? 0)}
            rawValue={formatNumber(totals?.charCount ?? 0)}
            accentVar="--chart-2"
          />
          <MetricCard
            icon={<Sparkles className="h-4 w-4" />}
            label={t("usage.claudeTokens")}
            value={formatCompact(claudeTokens)}
            rawValue={formatNumber(claudeTokens)}
            hitRate={claudeHit}
            hitRateLabel={t("usage.claudeHitRate")}
            hitRateHelp={t("usage.hitRateHelpClaude")}
            accentVar="--chart-1"
          />
          <MetricCard
            icon={<Cpu className="h-4 w-4" />}
            label={t("usage.codexTokens")}
            value={formatCompact(codexTokens)}
            rawValue={formatNumber(codexTokens)}
            hitRate={codexHit}
            hitRateLabel={t("usage.codexHitRate")}
            hitRateHelp={t("usage.hitRateHelpCodex")}
            accentVar="--chart-3"
          />
        </div>

        {/* 趋势区域 */}
        <div className="mt-4">
          {error ? (
            <div
              className="flex h-[280px] items-center justify-center text-sm"
              style={{ color: "var(--destructive)" }}
            >
              {error}
            </div>
          ) : loading && !data ? (
            <div
              className="flex h-[280px] items-center justify-center text-sm"
              style={{ color: "var(--app-text-tertiary)" }}
            >
              {t("usage.loading")}
            </div>
          ) : !hasData ? (
            <div
              className="flex h-[160px] items-center justify-center text-sm"
              style={{ color: "var(--app-text-tertiary)" }}
            >
              {t("usage.noData")}
            </div>
          ) : !showTrendCharts ? (
            <div
              className="flex h-[120px] items-center justify-center text-xs"
              style={{ color: "var(--app-text-tertiary)" }}
            >
              {t("usage.needLongerRange")}
            </div>
          ) : (
            <div className="space-y-4">
              {/* 主图：Token 曲线 */}
              <div>
                <div
                  className="mb-1 text-[11px] uppercase tracking-normal"
                  style={{ color: "var(--app-text-tertiary)" }}
                >
                  {t("usage.tokenChartTitle")}
                </div>
                <div className="h-[260px] min-w-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                      <CartesianGrid stroke="var(--app-home-row-border)" vertical={false} />
                      <XAxis
                        dataKey="date"
                        tick={{ fill: "var(--app-text-tertiary)", fontSize: 11 }}
                        tickLine={false}
                        axisLine={{ stroke: "var(--app-home-row-border)" }}
                      />
                      <YAxis
                        tick={{ fill: "var(--app-text-tertiary)", fontSize: 11 }}
                        tickFormatter={formatNumber}
                        width={64}
                        axisLine={false}
                        tickLine={false}
                      />
                      <Tooltip
                        formatter={(value, name) => [
                          formatNumber(Number(value) || 0),
                          String(name ?? ""),
                        ]}
                        contentStyle={{
                          background: "var(--app-home-surface)",
                          border: "1px solid var(--app-home-border)",
                          borderRadius: 8,
                          color: "var(--app-text-primary)",
                        }}
                      />
                      <Legend
                        wrapperStyle={{ fontSize: 12, cursor: "pointer" }}
                        onClick={(payload) => {
                          const key = String((payload as { dataKey?: string }).dataKey ?? "");
                          if (key) setHiddenTokenLines((s) => toggleHidden(s, key));
                        }}
                      />
                      <Line
                        type="monotone"
                        dataKey="claudeTokens"
                        name={t("usage.claudeTokens")}
                        stroke="var(--chart-1)"
                        strokeWidth={2}
                        dot={false}
                        hide={hiddenTokenLines.has("claudeTokens")}
                      />
                      <Line
                        type="monotone"
                        dataKey="codexTokens"
                        name={t("usage.codexTokens")}
                        stroke="var(--chart-3)"
                        strokeWidth={2}
                        dot={false}
                        hide={hiddenTokenLines.has("codexTokens")}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* 副图：字符曲线（独立小图，量级独立） */}
              <div>
                <div
                  className="mb-1 text-[11px] uppercase tracking-normal"
                  style={{ color: "var(--app-text-tertiary)" }}
                >
                  {t("usage.charsChartTitle")}
                </div>
                <div className="h-[140px] min-w-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                      <CartesianGrid stroke="var(--app-home-row-border)" vertical={false} />
                      <XAxis
                        dataKey="date"
                        tick={{ fill: "var(--app-text-tertiary)", fontSize: 10 }}
                        tickLine={false}
                        axisLine={{ stroke: "var(--app-home-row-border)" }}
                      />
                      <YAxis
                        tick={{ fill: "var(--app-text-tertiary)", fontSize: 10 }}
                        tickFormatter={formatNumber}
                        width={48}
                        axisLine={false}
                        tickLine={false}
                      />
                      <Tooltip
                        formatter={(value, name) => [
                          formatNumber(Number(value) || 0),
                          String(name ?? ""),
                        ]}
                        contentStyle={{
                          background: "var(--app-home-surface)",
                          border: "1px solid var(--app-home-border)",
                          borderRadius: 8,
                          color: "var(--app-text-primary)",
                          fontSize: 12,
                        }}
                      />
                      <Line
                        type="monotone"
                        dataKey="totalChars"
                        name={t("usage.inputChars")}
                        stroke="var(--chart-2)"
                        strokeWidth={2}
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

interface MetricCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  rawValue?: string;
  hitRate?: number | null;
  hitRateLabel?: string;
  hitRateHelp?: string;
  accentVar: string;
}

function MetricCard({
  icon,
  label,
  value,
  rawValue,
  hitRate,
  hitRateLabel,
  hitRateHelp,
  accentVar,
}: MetricCardProps) {
  const accent = `var(${accentVar})`;
  const hasHitRate = hitRate !== undefined && hitRateLabel !== undefined;
  const pct = hitRate !== null && hitRate !== undefined ? Math.max(0, Math.min(1, hitRate)) : null;
  return (
    <div
      className="group relative min-w-0 overflow-hidden rounded-xl border p-4 transition-colors"
      style={{
        background: "var(--app-home-surface)",
        borderColor: "var(--app-home-border)",
      }}
    >
      {/* 左侧细色条 */}
      <div
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: accent, opacity: 0.85 }}
      />
      <div className="flex items-center gap-2">
        <span
          className="inline-flex h-7 w-7 items-center justify-center rounded-md"
          style={{
            background: `color-mix(in srgb, ${accent} 14%, transparent)`,
            color: accent,
          }}
        >
          {icon}
        </span>
        <span
          className="truncate text-[11px] font-medium uppercase tracking-wide"
          style={{ color: "var(--app-text-tertiary)" }}
        >
          {label}
        </span>
      </div>
      <div
        className="mt-2 truncate text-2xl font-semibold tabular-nums"
        style={{ color: "var(--app-text-primary)" }}
        title={rawValue}
      >
        {value}
      </div>
      {hasHitRate && (
        <div className="mt-3" title={hitRateHelp}>
          <div className="flex items-center justify-between text-[11px]">
            <span style={{ color: "var(--app-text-tertiary)" }}>{hitRateLabel}</span>
            <span
              className="font-medium tabular-nums"
              style={{ color: "var(--app-text-secondary)" }}
            >
              {formatPercent(hitRate ?? null)}
            </span>
          </div>
          <div
            className="mt-1.5 h-1.5 overflow-hidden rounded-full"
            style={{ background: "var(--app-home-row-border)" }}
          >
            {pct !== null && (
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${pct * 100}%`, background: accent }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
