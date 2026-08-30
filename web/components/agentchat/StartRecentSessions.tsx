// 启动页的「最近会话」区：本项目/全部切换 + 关键词过滤 + 续接 + 复制会话 id。
// 从 EnginePicker 拆出（行数棘轮）。
import { useMemo, useState } from "react";
import { Copy, History, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AcpChatHistoryEntry } from "@/types/agentChat";
import { handleErrorSilent } from "@/utils/errorHandler";
import { samePath } from "./chatPaths";

function formatHistoryTime(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return "";
  }
}

export interface StartRecentSessionsProps {
  entries: AcpChatHistoryEntry[];
  cwd: string;
  /** 正在启动/续接中的标识（引擎 id 或 acpSessionId），非空时禁点。 */
  startingId: string | null;
  onResume: (entry: AcpChatHistoryEntry) => void;
}

export default function StartRecentSessions({
  entries,
  cwd,
  startingId,
  onResume,
}: StartRecentSessionsProps) {
  const { t } = useTranslation("panes");
  const [filter, setFilter] = useState("");
  const [scope, setScope] = useState<"project" | "all">("project");

  const filtered = useMemo(() => {
    const query = filter.trim().toLowerCase();
    let list = entries;
    if (scope === "project" && cwd) {
      list = list.filter((entry) => samePath(entry.cwd, cwd));
    }
    if (!query) return list;
    return list.filter((entry) =>
      [entry.title, entry.cwd, entry.engineId, entry.acpSessionId]
        .join("\n")
        .toLowerCase()
        .includes(query),
    );
  }, [entries, filter, scope, cwd]);

  if (entries.length === 0) return null;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-1.5 pb-6">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--app-icon-inactive)]">
        <History className="h-3.5 w-3.5" /> {t("agentChatHistoryTitle")}
        {cwd ? (
          <div className="flex overflow-hidden rounded border border-[var(--app-border)] text-[10px]">
            {(["project", "all"] as const).map((candidate) => (
              <button
                key={candidate}
                type="button"
                className={`px-1.5 py-px transition-colors ${
                  scope === candidate
                    ? "bg-[var(--app-active-bg)] text-[var(--app-icon-active)]"
                    : "hover:bg-[var(--app-hover)]"
                }`}
                onClick={() => setScope(candidate)}
              >
                {candidate === "project"
                  ? t("agentChatHistoryScopeProject")
                  : t("agentChatHistoryScopeAll")}
              </button>
            ))}
          </div>
        ) : null}
        <span className="flex-1" />
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t("agentChatHistoryFilter")}
          className="w-32 rounded border border-[var(--app-border)] bg-transparent px-1.5 py-0.5 text-[11px] outline-none focus:border-[var(--app-icon-active)]"
        />
      </div>
      <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto">
        {filtered.slice(0, 30).map((entry) => (
          <div
            key={entry.acpSessionId}
            className="group flex items-center gap-1 rounded-md border border-[var(--app-border)] px-2 py-1.5 transition-colors hover:bg-[var(--app-hover)]"
          >
            <button
              type="button"
              disabled={startingId !== null}
              className="flex min-w-0 flex-1 flex-col gap-0.5 text-left disabled:opacity-50"
              onClick={() => onResume(entry)}
            >
              <span className="flex items-center gap-2">
                <span className="flex-1 truncate text-xs">
                  {entry.title || entry.acpSessionId}
                </span>
                {startingId === entry.acpSessionId ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                ) : (
                  <span className="shrink-0 text-[10px] text-[var(--app-icon-inactive)]">
                    {entry.engineId}
                  </span>
                )}
              </span>
              <span className="truncate text-[10px] text-[var(--app-icon-inactive)]">
                {formatHistoryTime(entry.updatedAt)} · {entry.cwd}
              </span>
            </button>
            <button
              type="button"
              aria-label={t("agentChatCopySessionId")}
              title={t("agentChatCopySessionId")}
              className="shrink-0 rounded p-1 text-[var(--app-icon-inactive)] opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--app-active-bg)] hover:text-[var(--app-icon-active)]"
              onClick={() => {
                void navigator.clipboard
                  .writeText(entry.acpSessionId)
                  .catch((copyError) => handleErrorSilent(copyError, "copy acp session id"));
              }}
            >
              <Copy className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
