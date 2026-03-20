/**
 * CLI 工具列表 Hook — 缓存已注册的 CLI 工具信息
 */
import { useState, useEffect, useCallback } from "react";
import type { CliToolInfo } from "@/types";
import { listCliTools } from "@/services/cliToolService";

interface UseCliToolsReturn {
  /** 所有已注册的 CLI 工具 */
  tools: CliToolInfo[];
  /** 是否正在加载 */
  loading: boolean;
  /** 手动刷新 */
  refresh: () => Promise<void>;
  /** 按 id 查找工具 */
  getToolById: (id: string) => CliToolInfo | undefined;
  /** 获取已安装的工具列表 */
  installedTools: CliToolInfo[];
}

export function useCliTools(): UseCliToolsReturn {
  const [tools, setTools] = useState<CliToolInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await listCliTools();
      setTools(result);
    } catch (err) {
      console.error("[useCliTools] Failed to fetch CLI tools:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const getToolById = useCallback(
    (id: string) => tools.find((t) => t.id === id),
    [tools],
  );

  const installedTools = tools.filter((t) => t.installed);

  return { tools, loading, refresh, getToolById, installedTools };
}
