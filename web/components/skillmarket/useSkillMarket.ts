// 技能市场数据层：目录加载 / 联网搜索（防抖 + 竞态守卫）/ 描述懒补全 / 安装卸载。
// 页面组件只消费这里的状态与动作，不直接碰 skillService。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { skillService } from "@/services/skillService";
import type { SkillMarketEntry } from "@/types";
import { handleErrorSilent } from "@/utils/errorHandler";
import { needsDescription } from "./skillMarketModel";

const SEARCH_DEBOUNCE_MS = 350;
const DESCRIBE_CONCURRENCY = 3;

export function useSkillMarket() {
  const { t } = useTranslation("skillMarket");
  const [catalog, setCatalog] = useState<SkillMarketEntry[]>([]);
  const [installedIds, setInstalledIds] = useState<ReadonlySet<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SkillMarketEntry[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // 懒补全的描述覆盖层：按 id 叠在目录/搜索结果之上，切换视图不丢
  const [described, setDescribed] = useState<Record<string, SkillMarketEntry>>({});
  const describeQueue = useRef<Set<string>>(new Set());
  const searchSeq = useRef(0);

  const reloadInstalled = useCallback(async () => {
    try {
      const skills = await skillService.listUserSkills();
      setInstalledIds(new Set(skills.map((skill) => skill.id)));
    } catch (error) {
      handleErrorSilent(error, "list user skills");
    }
  }, []);

  const loadCatalog = useCallback(
    async (refresh: boolean) => {
      if (refresh) setRefreshing(true);
      else setLoading(true);
      setLoadError(null);
      try {
        const [entries] = await Promise.all([
          skillService.listSkillMarketEntries(refresh),
          reloadInstalled(),
        ]);
        setCatalog(entries);
      } catch (error) {
        setLoadError(String(error));
        toast.error(t("toast.loadFailed", { error: String(error) }));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [reloadInstalled, t],
  );

  useEffect(() => {
    void loadCatalog(false);
  }, [loadCatalog]);

  // 搜索：空串直接回目录；否则防抖后请求，晚到的旧结果按序号丢弃
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    const seq = ++searchSeq.current;
    setSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const results = await skillService.searchSkillMarket(trimmed);
        if (seq === searchSeq.current) setSearchResults(results);
      } catch (error) {
        if (seq === searchSeq.current) {
          handleErrorSilent(error, "search skill market");
          setSearchResults([]);
        }
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const entries = useMemo(() => {
    const base = searchResults ?? catalog;
    return base.map((entry) => described[entry.id] ?? entry);
  }, [catalog, searchResults, described]);

  /** 为一批可见条目补描述；已处理/在途的跳过，限并发以免打爆 GitHub 配额 */
  const ensureDescribed = useCallback((visible: readonly SkillMarketEntry[]) => {
    const pending = visible.filter(
      (entry) => needsDescription(entry) && !describeQueue.current.has(entry.id),
    );
    if (pending.length === 0) return;
    pending.forEach((entry) => describeQueue.current.add(entry.id));
    let cursor = 0;
    const worker = async () => {
      while (cursor < pending.length) {
        const entry = pending[cursor++];
        try {
          const enriched = await skillService.describeSkillMarketEntry(entry);
          setDescribed((current) => ({ ...current, [entry.id]: enriched }));
        } catch (error) {
          handleErrorSilent(error, "describe skill market entry");
        }
      }
    };
    for (let index = 0; index < Math.min(DESCRIBE_CONCURRENCY, pending.length); index += 1) {
      void worker();
    }
  }, []);

  const install = useCallback(
    async (entry: SkillMarketEntry) => {
      setBusyId(entry.id);
      try {
        const installed = await skillService.installSkillMarketEntry(entry);
        setInstalledIds((current) => new Set([...current, installed.id]));
        toast.success(t("toast.installed", { name: installed.name }));
      } catch (error) {
        toast.error(t("toast.installFailed", { error: String(error) }));
      } finally {
        setBusyId(null);
      }
    },
    [t],
  );

  const remove = useCallback(
    async (entry: SkillMarketEntry) => {
      setBusyId(entry.id);
      try {
        await skillService.removeUserSkill(entry.id);
        setInstalledIds((current) => {
          const next = new Set(current);
          next.delete(entry.id);
          return next;
        });
        toast.success(t("toast.removed", { name: entry.name }));
      } catch (error) {
        toast.error(t("toast.removeFailed", { error: String(error) }));
      } finally {
        setBusyId(null);
      }
    },
    [t],
  );

  return {
    entries,
    catalog,
    installedIds,
    loading,
    refreshing,
    loadError,
    query,
    setQuery,
    isSearchMode: searchResults !== null,
    searching,
    busyId,
    refresh: () => loadCatalog(true),
    ensureDescribed,
    install,
    remove,
  };
}
