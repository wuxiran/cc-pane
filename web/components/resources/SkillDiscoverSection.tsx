// 「发现」：精选清单 + Anthropic 官方仓库 + skills.sh 搜索，装进资源库。复用技能市场的数据层，不受实验开关限制。
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Search } from "lucide-react";
import SkillMarketCard from "@/components/skillmarket/SkillMarketCard";
import { pickFeatured } from "@/components/skillmarket/skillMarketModel";
import { USER_INSTALL_TARGET, useSkillMarket } from "@/components/skillmarket/useSkillMarket";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSkillLibraryStore } from "@/stores/useSkillLibraryStore";
import type { SkillMarketEntry } from "@/types";
import { handleErrorSilent } from "@/utils/errorHandler";

const PAGE_SIZE = 48;
const FEATURED_MAX = 8;

export default function SkillDiscoverSection({ onRemove }: { onRemove: (id: string) => void }) {
  const { t } = useTranslation("settings");
  const market = useSkillMarket(USER_INSTALL_TARGET);
  const librarySkills = useSkillLibraryStore((s) => s.skills);
  const loadLibrary = useSkillLibraryStore((s) => s.load);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const { reloadInstalled, ensureDescribed } = market;

  // 在资源库里装、删之后，市场卡片的「已安装」跟着变
  useEffect(() => {
    void reloadInstalled();
  }, [librarySkills, reloadInstalled]);

  const featured = useMemo(() => (market.isSearchMode ? [] : pickFeatured(market.catalog, FEATURED_MAX)), [market.catalog, market.isSearchMode]);
  const featuredIds = useMemo(() => new Set(featured.map((entry) => entry.id)), [featured]);
  const rest = useMemo(() => market.entries.filter((entry) => !featuredIds.has(entry.id)), [market.entries, featuredIds]);
  const shown = useMemo(() => [...featured, ...rest].slice(0, limit), [featured, rest, limit]);

  useEffect(() => {
    setLimit(PAGE_SIZE);
  }, [market.query]);
  useEffect(() => {
    ensureDescribed(shown);
  }, [shown, ensureDescribed]);

  const install = async (entry: SkillMarketEntry) => {
    await market.install(entry);
    await loadLibrary().catch((error) => handleErrorSilent(error, "reload skill library"));
  };

  return (
    <section aria-label={t("skillLibrary.discoverTitle")} data-testid="skill-discover-section">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xs font-medium" style={{ color: "var(--app-text-secondary)" }}>{t("skillLibrary.discoverTitle")}</h2>
        <span className="text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>{t("skillLibrary.discoverHint")}</span>
      </div>
      <div className="relative mb-3">
        <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: "var(--app-text-tertiary)" }} />
        <Input
          value={market.query}
          onChange={(event) => market.setQuery(event.target.value)}
          placeholder={t("skillLibrary.discoverSearch")}
          aria-label={t("skillLibrary.discoverSearch")}
          className="h-9 pl-8 text-sm"
        />
        {market.searching && <Loader2 size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin" style={{ color: "var(--app-text-tertiary)" }} />}
      </div>
      {market.loading ? (
        <p role="status" className="flex items-center gap-1.5 py-4 text-xs" style={{ color: "var(--app-text-tertiary)" }}><Loader2 size={12} className="animate-spin" />{t("skillLibrary.discoverLoading")}</p>
      ) : market.loadError && market.catalog.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <p className="text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("skillLibrary.discoverOffline")}</p>
          <Button size="sm" variant="outline" onClick={() => void market.refresh()}>{t("skillLibrary.discoverRetry")}</Button>
        </div>
      ) : shown.length === 0 ? (
        <p className="py-6 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("skillLibrary.discoverEmpty")}</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(236px,1fr))] gap-3">
          {shown.map((entry) => (
            <SkillMarketCard
              key={entry.id}
              entry={entry}
              featured={featuredIds.has(entry.id)}
              installed={market.isInstalled(entry)}
              busy={market.busyId === entry.id}
              onInstall={(item) => void install(item)}
              onRemove={(item) => onRemove(item.id)}
            />
          ))}
        </div>
      )}
      {featured.length + rest.length > limit && (
        <div className="mt-3 flex justify-center">
          <Button size="sm" variant="ghost" onClick={() => setLimit(limit + PAGE_SIZE)}>{t("resourceLibrary.marketMore")}</Button>
        </div>
      )}
    </section>
  );
}
