/**
 * CLI 工具列表 Hook — 缓存已注册的 CLI 工具信息
 */
import { useState, useEffect, useCallback } from "react";
import type { CliToolInfo } from "@/types";
import { CLI_TOOL_TABS } from "@/types/provider";
import { listCliTools } from "@/services/cliToolService";

/** CLI detection runs external --version commands; never leave settings blank forever. */
export const CLI_TOOLS_REQUEST_TIMEOUT_MS = 10_000;

const FALLBACK_TOOL_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  pi: "Pi",
  omp: "OMP",
  gemini: "Gemini CLI",
  kimi: "Kimi CLI",
  opencode: "OpenCode",
  cursor: "Cursor Agent",
  grok: "Grok CLI",
  jcode: "JCode",
};

/** Static metadata keeps the settings editor usable while host detection is slow or unavailable. */
export const FALLBACK_CLI_TOOLS: CliToolInfo[] = CLI_TOOL_TABS.map(({ id }) => ({
  id,
  displayName: FALLBACK_TOOL_LABELS[id] ?? id,
  executable: id === "cursor" ? "cursor-agent" : id,
  versionArgs: ["--version"],
  installed: false,
  version: null,
  path: null,
}));

function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error(`CLI detection timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    task.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

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
  const [tools, setTools] = useState<CliToolInfo[]>(FALLBACK_CLI_TOOLS);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await withTimeout(listCliTools(), CLI_TOOLS_REQUEST_TIMEOUT_MS);
      setTools(result);
    } catch (err) {
      console.error("[useCliTools] Failed to fetch CLI tools:", err);
      // Keep the editor usable. Real installed/path/version data will replace this
      // list on the next successful refresh; no tool is claimed installed here.
      setTools((current) => current.length > 0 ? current : FALLBACK_CLI_TOOLS);
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
