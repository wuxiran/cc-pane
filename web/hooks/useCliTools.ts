/** CLI 检测只返回宿主探测结果；未知状态不冒充「未安装」。 */
import { useState, useEffect, useCallback, useRef } from "react";
import type { CliToolInfo } from "@/types";
import { listCliTools } from "@/services/cliToolService";

export const CLI_TOOLS_REQUEST_TIMEOUT_MS = 10_000;

interface UseCliToolsReturn {
  /** 最近一次成功探测的工具列表；首次探测未成功时为空。 */
  tools: CliToolInfo[];
  loading: boolean;
  refresh: () => Promise<void>;
  getToolById: (id: string) => CliToolInfo | undefined;
  installedTools: CliToolInfo[];
}

export function useCliTools(): UseCliToolsReturn {
  const [tools, setTools] = useState<CliToolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(false);
  const latestRequest = useRef(0);
  const finishWaiting = useRef<(() => void) | null>(null);

  const refresh = useCallback((): Promise<void> => {
    if (!mounted.current) return Promise.resolve();
    const requestId = ++latestRequest.current;
    finishWaiting.current?.();
    setLoading(true);
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
          const result = await listCliTools();
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

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      latestRequest.current += 1;
      finishWaiting.current?.();
    };
  }, [refresh]);

  const getToolById = useCallback(
    (id: string) => tools.find((tool) => tool.id === id),
    [tools],
  );
  const installedTools = tools.filter((tool) => tool.installed);
  return { tools, loading, refresh, getToolById, installedTools };
}
