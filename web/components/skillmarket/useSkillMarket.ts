// 技能市场数据层：目录加载 / 联网搜索（防抖 + 竞态守卫）/ 描述懒补全 / 安装卸载。
// 页面组件只消费这里的状态与动作，不直接碰 skillService。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toastErr, toastOk } from "@/lib/feedback";
import { skillService } from "@/services/skillService";
import type { SkillMarketEntry } from "@/types";
import { handleErrorSilent } from "@/utils/errorHandler";
import { needsDescription } from "./skillMarketModel";

const SEARCH_DEBOUNCE_MS = 350;
const DESCRIBE_CONCURRENCY = 3;

/** 安装目标：用户级（所有工作空间可用）或某个工作空间（workspace-first 默认） */
export const USER_INSTALL_TARGET = "__user__";

/** 目录型条目落盘时的文件夹名（与后端 repo_skill_leaf 一致） */
export function entryLeaf(entry: SkillMarketEntry): string {
  const path = entry.path?.replace(/\/+$/, "");
  const leaf = path ? path.split("/").pop() : undefined;
  return leaf || entry.name;
}

export function useSkillMarket(initialTarget: string = USER_INSTALL_TARGET) {
  const { t } = useTranslation("skillMarket");
  const [catalog, setCatalog] = useState<SkillMarketEntry[]>([]);
  const [installTarget, setInstallTarget] = useState<string>(initialTarget);
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

  // 已安装集合随安装目标切换：用户级看 user skills 的 id，工作空间看其技能目录名
  const reloadInstalled = useCallback(async () => {
    try {
      if (installTarget === USER_INSTALL_TARGET) {
        const skills = await skillService.listUserSkills();
        setInstalledIds(new Set(skills.map((skill) => skill.id)));
      } else {
        const skills = await skillService.listWorkspaceSkills(installTarget);
        setInstalledIds(new Set(skills.map((skill) => skill.relDir)));
      }
    } catch (error) {
      handleErrorSilent(error, "list installed skills");
    }
  }, [installTarget]);

  useEffect(() => {
    void reloadInstalled();
  }, [reloadInstalled]);

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
        toastErr(t("toast.loadFailed", { error: String(error) }));
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

  const toWorkspace = installTarget !== USER_INSTALL_TARGET;
  const installedKey = useCallback(
    (entry: SkillMarketEntry) => (toWorkspace ? entryLeaf(entry) : entry.id),
    [toWorkspace],
  );

  const install = useCallback(
    async (entry: SkillMarketEntry) => {
      setBusyId(entry.id);
      try {
        const installed = await skillService.installSkillMarketEntry(
          entry,
          toWorkspace ? installTarget : null,
        );
        setInstalledIds((current) => new Set([...current, installedKey(entry)]));
        toastOk(
          toWorkspace
            ? t("toast.installedToWorkspace", { name: installed.name, workspace: installTarget })
            : t("toast.installed", { name: installed.name }),
        );
      } catch (error) {
        toastErr(t("toast.installFailed", { error: String(error) }));
      } finally {
        setBusyId(null);
      }
    },
    [t, toWorkspace, installTarget, installedKey],
  );

  const remove = useCallback(
    async (entry: SkillMarketEntry) => {
      setBusyId(entry.id);
      try {
        if (toWorkspace) {
          await skillService.deleteWorkspaceSkill(installTarget, entryLeaf(entry));
        } else {
          await skillService.removeUserSkill(entry.id);
        }
        setInstalledIds((current) => {
          const next = new Set(current);
          next.delete(installedKey(entry));
          return next;
        });
        toastOk(t("toast.removed", { name: entry.name }));
      } catch (error) {
        toastErr(t("toast.removeFailed", { error: String(error) }));
      } finally {
        setBusyId(null);
      }
    },
    [t, toWorkspace, installTarget, installedKey],
  );

  return {
    entries,
    catalog,
    installTarget,
    setInstallTarget,
    installedIds,
    isInstalled: (entry: SkillMarketEntry) => installedIds.has(installedKey(entry)),
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
