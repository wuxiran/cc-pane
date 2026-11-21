/**
 * 已装 Agent 的最新版本（后端 check_cli_updates）。要联网查 npm / Homebrew，
 * 所以结果在模块级缓存 30 分钟：首页反复进出不重复查；「重新检测」时强制刷新。
 * 当前版本不在这里缓存——由 useCliTools 实时检测，升级完回到窗口自然对得上。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { checkCliUpdates, type CliUpdateInfo } from "@/services/cliUpdateService";

const CACHE_TTL_MS = 30 * 60_000;

let cache: { at: number; infos: CliUpdateInfo[] } | null = null;
let inflight: Promise<CliUpdateInfo[]> | null = null;

function fetchUpdates(force: boolean): Promise<CliUpdateInfo[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return Promise.resolve(cache.infos);
  if (inflight) return inflight;
  inflight = checkCliUpdates()
    .then((infos) => {
      cache = { at: Date.now(), infos };
      return infos;
    })
    .catch((error) => {
      console.warn("[useCliUpdates] check failed:", error);
      return cache?.infos ?? [];
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 测试用：清掉模块缓存。 */
export function resetCliUpdatesCache(): void {
  cache = null;
  inflight = null;
}

export function useCliUpdates(enabled: boolean): {
  infos: CliUpdateInfo[];
  checking: boolean;
  recheck: () => void;
} {
  const [infos, setInfos] = useState<CliUpdateInfo[]>(() => cache?.infos ?? []);
  const [checking, setChecking] = useState(false);
  const mounted = useRef(true);

  const run = useCallback((force: boolean) => {
    setChecking(true);
    void fetchUpdates(force).then((result) => {
      if (!mounted.current) return;
      setInfos(result);
      setChecking(false);
    });
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (enabled) run(false);
  }, [enabled, run]);

  const recheck = useCallback(() => run(true), [run]);
  return { infos, checking, recheck };
}
