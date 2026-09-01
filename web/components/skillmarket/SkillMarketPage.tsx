// 技能市场全屏页：顶部标题/搜索/已安装计数，精选横排，分类页签 + 卡片网格。
// 数据全部来自 useSkillMarket；本文件只管布局与交互编排。
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, PackageSearch, RefreshCw, Search, Store, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { navigateToSettings } from "@/components/settings/settingsNavigation";
import SkillMarketCard from "./SkillMarketCard";
import {
  filterByCategory,
  pickFeatured,
  presentCategories,
  type CategoryFilter,
} from "./skillMarketModel";
import { useSkillMarket } from "./useSkillMarket";

const FEATURED_MAX = 8;
const DESCRIBE_WINDOW = 36;

export default function SkillMarketPage() {
  const { t } = useTranslation("skillMarket");
  const market = useSkillMarket();
  const [category, setCategory] = useState<CategoryFilter>("all");

  const categories = useMemo(() => presentCategories(market.entries), [market.entries]);
  const visible = useMemo(
    () => filterByCategory(market.entries, category),
    [market.entries, category],
  );
  const featured = useMemo(
    () => (market.isSearchMode ? [] : pickFeatured(market.catalog, FEATURED_MAX)),
    [market.catalog, market.isSearchMode],
  );

  // 分类在当前结果里消失时回到「全部」，避免空网格
  useEffect(() => {
    if (category !== "all" && !categories.includes(category)) setCategory("all");
  }, [categories, category]);

  // 只为首屏附近的卡片补描述，搜索结果多为 skills.sh 条目（无描述）
  useEffect(() => {
    market.ensureDescribed([...featured, ...visible.slice(0, DESCRIBE_WINDOW)]);
  }, [featured, visible, market.ensureDescribed]);

  const showOffline = !market.loading && market.loadError !== null && market.catalog.length === 0;

  return (
    <div className="flex h-full flex-col" data-testid="skill-market-page">
      <header className="shrink-0 px-6 pb-3 pt-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-base font-semibold" style={{ color: "var(--app-text-primary)" }}>
              <Store className="size-4" style={{ color: "var(--app-accent)" }} />
              {t("title")}
            </h1>
            <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--app-text-tertiary)" }}>
              {t("subtitle")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => navigateToSettings({ paneId: "skills" })}
            >
              {t("installedCount", { count: market.installedIds.size })}
              <span className="sr-only">{t("manageInstalled")}</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 text-xs"
              disabled={market.refreshing || market.loading}
              onClick={() => void market.refresh()}
              aria-label={t("refresh")}
              title={t("refresh")}
            >
              <RefreshCw className={`size-3.5 ${market.refreshing ? "animate-spin" : ""}`} />
              {market.refreshing ? t("refreshing") : t("refresh")}
            </Button>
          </div>
        </div>
        <div className="relative mt-4 max-w-xl">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2"
            style={{ color: "var(--app-text-tertiary)" }}
          />
          <Input
            value={market.query}
            onChange={(event) => market.setQuery(event.target.value)}
            placeholder={t("searchPlaceholder")}
            className="h-9 pl-9 pr-9 text-sm"
            aria-label={t("searchPlaceholder")}
          />
          {market.searching && (
            <Loader2
              className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin"
              style={{ color: "var(--app-text-tertiary)" }}
              aria-label={t("searching")}
            />
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        {market.loading ? (
          <LoadingGrid />
        ) : showOffline ? (
          <EmptyState
            icon={WifiOff}
            title={t("offline.title")}
            description={t("offline.hint")}
            action={{ label: t("refresh"), onClick: () => void market.refresh() }}
          />
        ) : (
          <>
            {featured.length > 0 && (
              <section className="mb-6" aria-label={t("featured")}>
                <SectionTitle>{t("featured")}</SectionTitle>
                <div className="grid grid-flow-col auto-cols-[minmax(240px,260px)] gap-3 overflow-x-auto pb-2">
                  {featured.map((entry) => (
                    <SkillMarketCard
                      key={`featured-${entry.id}`}
                      entry={entry}
                      featured
                      installed={market.installedIds.has(entry.id)}
                      busy={market.busyId === entry.id}
                      onInstall={market.install}
                      onRemove={market.remove}
                    />
                  ))}
                </div>
              </section>
            )}

            <section aria-label={t("browse")}>
              <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                <SectionTitle>
                  {t("browse")}
                  <span className="ml-2 text-xs font-normal" style={{ color: "var(--app-text-tertiary)" }}>
                    {t("resultCount", { count: visible.length })}
                  </span>
                </SectionTitle>
                {market.isSearchMode && (
                  <span className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
                    {t("remoteResultsHint")}
                  </span>
                )}
              </div>
              <div className="mb-4 flex flex-wrap gap-1.5" role="tablist" aria-label={t("browse")}>
                <CategoryChip
                  active={category === "all"}
                  label={t("allCategories")}
                  onClick={() => setCategory("all")}
                />
                {categories.map((id) => (
                  <CategoryChip
                    key={id}
                    active={category === id}
                    label={t(`categories.${id}`)}
                    onClick={() => setCategory(id)}
                  />
                ))}
              </div>

              {visible.length === 0 ? (
                <EmptyState
                  icon={PackageSearch}
                  title={t("empty.title")}
                  description={t("empty.hint")}
                />
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
                  {visible.map((entry) => (
                    <SkillMarketCard
                      key={entry.id}
                      entry={entry}
                      installed={market.installedIds.has(entry.id)}
                      busy={market.busyId === entry.id}
                      onInstall={market.install}
                      onRemove={market.remove}
                    />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-3 text-sm font-medium" style={{ color: "var(--app-text-primary)" }}>
      {children}
    </h2>
  );
}

function CategoryChip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className="rounded-full px-3 py-1 text-xs transition-colors"
      style={
        active
          ? {
              background: "color-mix(in srgb, var(--app-accent) 16%, transparent)",
              color: "var(--app-accent)",
            }
          : {
              background: "color-mix(in srgb, var(--app-text-primary) 5%, transparent)",
              color: "var(--app-text-secondary)",
            }
      }
    >
      {label}
    </button>
  );
}

function LoadingGrid() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3" aria-busy="true">
      {Array.from({ length: 12 }, (_, index) => (
        <Skeleton key={index} className="h-[128px] rounded-xl" />
      ))}
    </div>
  );
}
