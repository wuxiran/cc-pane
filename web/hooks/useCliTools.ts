/** CLI 检测只返回宿主探测结果；未知状态不冒充「未安装」。 */
import { useState, useEffect, useCallback, useRef } from "react";
import type { CliToolInfo } from "@/types";
import { listCliTools } from "@/services/cliToolService";

export const CLI_TOOLS_REQUEST_TIMEOUT_MS = 10_000;

/**
 * 会话级共享缓存。后端 detect_all 是串行的、每个已装 CLI 还要 spawn 一次 `--version`，
 * 一轮常要数秒；而同一页面往往有多个组件各挂一个 useCliTools（运行配置页就有三个）。
 * 没有缓存时每次进页都从空列表起步：全部 CLI 先被渲染成「未安装」、版本号空白，几秒后才跳回来。
 * 现在：有缓存就立即渲染缓存值，挂载时后台重验（不亮 loading）；同时挂载的实例共用一个在途请求。
 */
let sharedTools: CliToolInfo[] | null = null;
let sharedInflight: Promise<CliToolInfo[]> | null = null;
let sharedSeq = 0;
const subscribers = new Set<(tools: CliToolInfo[]) => void>();

function fetchSharedTools(force: boolean): Promise<CliToolInfo[]> {
  if (sharedInflight && !force) return sharedInflight;
  const seq = ++sharedSeq;
  const request = listCliTools().then((result) => {
    // 只让最新发起的请求写缓存，晚到的旧结果不覆盖新结果
    if (seq === sharedSeq) {
      sharedTools = result;
      subscribers.forEach((notify) => notify(result));
    }
    return result;
  });
  sharedInflight = request;
  const clear = () => {
    if (sharedInflight === request) sharedInflight = null;
  };
  request.then(clear, clear);
  return request;
}

/** 仅供测试：清空会话缓存，避免用例间串数据 */
export function resetCliToolsCacheForTests(): void {
  sharedTools = null;
  sharedInflight = null;
  sharedSeq += 1;
  subscribers.clear();
}

interface UseCliToolsReturn {
  /** 最近一次成功探测的工具列表；首次探测未成功时为空。 */
  tools: CliToolInfo[];
  loading: boolean;
  refresh: () => Promise<void>;
  getToolById: (id: string) => CliToolInfo | undefined;
  installedTools: CliToolInfo[];
}

export function useCliTools(): UseCliToolsReturn {
  const [tools, setTools] = useState<CliToolInfo[]>(() => sharedTools ?? []);
  const [loading, setLoading] = useState(() => sharedTools === null);
  const mounted = useRef(false);
  const latestRequest = useRef(0);
  const finishWaiting = useRef<(() => void) | null>(null);

  const runRequest = useCallback((force: boolean, background: boolean): Promise<void> => {
    if (!mounted.current) return Promise.resolve();
    const requestId = ++latestRequest.current;
    finishWaiting.current?.();
    if (!background) setLoading(true);
    const isCurrent = () => mounted.current && latestRequest.current === requestId;

    return new Promise<void>((resolve) => {
      const finish = () => {
        window.clearTimeout(timer);
        if (finishWaiting.current === finish) finishWaiting.current = null;
        resolve();
      };
      // End the loading indicator at the deadline, but keep accepting this
      // request's late result until a refresh or unmount supersedes it.
      const timer = window.setTimeout(() => {
        if (isCurrent()) setLoading(false);
        finish();
      }, CLI_TOOLS_REQUEST_TIMEOUT_MS);
      finishWaiting.current = finish;
      void (async () => {
        try {
          const result = await fetchSharedTools(force);
          if (isCurrent()) setTools(result);
        } catch (error) {
          if (isCurrent()) console.error("[useCliTools] Failed to fetch CLI tools:", error);
        } finally {
          if (isCurrent()) setLoading(false);
          finish();
        }
      })();
    });
  }, []);

  const refresh = useCallback(() => runRequest(true, false), [runRequest]);

  useEffect(() => {
    mounted.current = true;
    // 其他实例拿到新结果时同步过来（同页多个实例共享一份数据）
    const onShared = (result: CliToolInfo[]) => {
      if (mounted.current) setTools(result);
    };
    subscribers.add(onShared);
    // 有缓存：先渲染缓存，后台重验，不亮 loading；无缓存：照常首次探测
    void runRequest(false, sharedTools !== null);
    return () => {
      subscribers.delete(onShared);
      mounted.current = false;
      latestRequest.current += 1;
      finishWaiting.current?.();
    };
  }, [runRequest]);

  const getToolById = useCallback(
    (id: string) => tools.find((tool) => tool.id === id),
    [tools],
  );
  const installedTools = tools.filter((tool) => tool.installed);
  return { tools, loading, refresh, getToolById, installedTools };
}
