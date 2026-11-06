// 右侧面板对话的历史：「对话」是 Agent 对话（点开在面板里续接），「终端会话」是
// 原来右侧面板单独那页会话历史（Claude/Codex CLI 会话，恢复到终端）。
import { useCallback, useEffect, useMemo, useState } from "react";
import { MessagesSquare, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { agentChatService } from "@/services/agentChatService";
import { AGENT_CHAT_HISTORY_CHANGED_EVENT } from "@/stores/agentChatEvents";
import { useDockChatStore, type DockChatHistoryTab } from "@/stores/useDockChatStore";
import type { OpenTerminalOptions, Workspace, WorkspaceProject } from "@/types";
import type { AcpChatHistoryEntry } from "@/types/agentChat";
import { handleErrorSilent } from "@/utils/errorHandler";
import SessionHistoryView from "./SessionHistoryView";

const MAX_CHAT_ENTRIES = 100;

function projectNameOf(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
}

function samePath(a: string, b: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return normalize(a) === normalize(b);
}

/** 当前项目的对话排前面，其余按更新时间；关键字匹配标题和项目名。 */
export function filterChatHistory(entries: AcpChatHistoryEntry[], query: string, projectPath: string | null): AcpChatHistoryEntry[] {
  const needle = query.trim().toLowerCase();
  return entries
    .filter((entry) => entry.acpSessionId)
    .filter((entry) => !needle
      || entry.title.toLowerCase().includes(needle)
      || projectNameOf(entry.cwd).toLowerCase().includes(needle))
    .sort((a, b) => {
      const inA = projectPath ? samePath(a.cwd, projectPath) : false;
      const inB = projectPath ? samePath(b.cwd, projectPath) : false;
      if (inA !== inB) return inA ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    })
    .slice(0, MAX_CHAT_ENTRIES);
}

interface DockChatHistoryProps {
  workspaces: Workspace[];
  workspace: Workspace | null;
  project: WorkspaceProject | null;
  onOpenTerminal: (options: OpenTerminalOptions) => void;
}

export default function DockChatHistory({ workspaces, workspace, project, onOpenTerminal }: DockChatHistoryProps) {
  const { t } = useTranslation("sidebar");
  const tab = useDockChatStore((state) => state.historyTab);
  const setTab = (next: DockChatHistoryTab) => useDockChatStore.getState().openHistory(next);
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="dock-chat-history">
      <div className="mx-3 mt-2.5 flex shrink-0 overflow-hidden rounded-md border border-[var(--app-border)] text-xs" role="tablist">
        {(["chat", "terminal"] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`h-7 flex-1 transition-colors ${
              tab === key ? "bg-[var(--app-active-bg)] text-[var(--app-text-primary)]" : "text-[var(--app-text-tertiary)] hover:text-[var(--app-text-primary)]"
            }`}
          >
            {t(key === "chat" ? "rightDock.historyChats" : "rightDock.historyTerminals")}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === "chat" ? (
          <ChatHistoryList projectPath={project?.path ?? null} />
        ) : (
          <SessionHistoryView workspaces={workspaces} workspace={workspace} project={project} onOpenTerminal={onOpenTerminal} />
        )}
      </div>
    </div>
  );
}

function ChatHistoryList({ projectPath }: { projectPath: string | null }) {
  const { t } = useTranslation("sidebar");
  const [entries, setEntries] = useState<AcpChatHistoryEntry[]>([]);
  const [query, setQuery] = useState("");

  const reload = useCallback(() => {
    agentChatService
      .listHistory()
      .then(setEntries)
      .catch((error) => handleErrorSilent(error, "list dock chat history"));
  }, []);

  useEffect(() => {
    reload();
    window.addEventListener(AGENT_CHAT_HISTORY_CHANGED_EVENT, reload);
    return () => window.removeEventListener(AGENT_CHAT_HISTORY_CHANGED_EVENT, reload);
  }, [reload]);

  const visible = useMemo(() => filterChatHistory(entries, query, projectPath), [entries, query, projectPath]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <label className="mx-3 mt-2 flex h-8 shrink-0 items-center gap-2 rounded-md border border-[var(--app-border)] px-2 text-[var(--app-text-tertiary)]">
        <Search className="size-3.5 shrink-0" />
        <span className="sr-only">{t("rightDock.searchChats")}</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("rightDock.searchChats")}
          className="min-w-0 flex-1 bg-transparent text-xs text-[var(--app-text-primary)] outline-none placeholder:text-[var(--app-text-tertiary)]"
        />
      </label>
      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {visible.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-8 text-center text-xs text-[var(--app-text-tertiary)]">
            <MessagesSquare className="size-6 opacity-40" />
            {t(query ? "rightDock.noMatchingChats" : "agentChatsEmpty")}
          </div>
        ) : visible.map((entry) => (
          <button
            key={entry.acpSessionId}
            type="button"
            data-testid="dock-chat-history-entry"
            className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--app-hover)]"
            onClick={() => useDockChatStore.getState().resume(entry)}
          >
            <span className="flex items-center gap-1.5">
              <span className="flex-1 truncate text-xs text-[var(--app-text-primary)]">{entry.title || entry.acpSessionId}</span>
              <span className="shrink-0 text-[length:var(--text-micro)] text-[var(--app-text-tertiary)]">{entry.engineId}</span>
            </span>
            <span className="truncate text-[length:var(--text-micro)] text-[var(--app-text-tertiary)]">
              {projectNameOf(entry.cwd)} · {new Date(entry.updatedAt).toLocaleString()}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
