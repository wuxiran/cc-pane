// 会话命名索引：resumeId(=CLI session id) → session_index 的 CLI 标题 + 首条输入。
// 后台索引默认 300s 才扫一轮，对「刚开的会话」太慢——终端模式开启期间主动触发
// 增量扫描（refresh 有 mtime/size 跳过，稳态近零成本）再拉取，60s 一轮；
// history-updated（resume id 绑定等）时立即补一轮。
import { useEffect, useState } from "react";
import { sessionIndexService } from "@/services/sessionIndexService";
import { handleErrorSilent } from "@/utils";
import { startVisibleInterval } from "@/utils/visibleInterval";
import type { SessionLabel } from "@/components/sidebar/workspaceTerminals";

const LIST_LIMIT = 500;
const REFRESH_INTERVAL_MS = 60_000;

export function useFirstPromptIndex(enabled: boolean): ReadonlyMap<string, SessionLabel> {
  const [prompts, setPrompts] = useState<ReadonlyMap<string, SessionLabel>>(new Map());

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let inFlight = false;

    const load = async (withRefresh: boolean) => {
      if (inFlight) return;
      inFlight = true;
      try {
        if (withRefresh) {
          // 增量扫描：只解析 mtime/size 变化的转录文件，不唤醒 WSL VM（首扫策略见 docs 0.11.2）
          await sessionIndexService.refresh().catch(() => undefined);
        }
        const entries = await sessionIndexService.list({ scope: "all", limit: LIST_LIMIT });
        if (cancelled) return;
        const next = new Map<string, SessionLabel>();
        for (const entry of entries) {
          const title = entry.title ?? "";
          if (entry.firstPrompt || title) {
            next.set(entry.sessionId, { title, firstPrompt: entry.firstPrompt });
          }
        }
        setPrompts(next);
      } catch (error) {
        handleErrorSilent(error, "useFirstPromptIndex.load");
      } finally {
        inFlight = false;
      }
    };

    void load(true);
    const stopRefresh = startVisibleInterval(() => void load(true), REFRESH_INTERVAL_MS);
    const onHistoryUpdated = () => void load(true);
    window.addEventListener("cc-panes:history-updated", onHistoryUpdated);
    return () => {
      cancelled = true;
      stopRefresh();
      window.removeEventListener("cc-panes:history-updated", onHistoryUpdated);
    };
  }, [enabled]);

  return prompts;
}
