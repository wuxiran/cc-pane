// agent-chat 引擎选择页：内置+自定义引擎列表（已安装优先）+ 工作目录选择 +
// 最近会话续接。从 AgentChatTabContent 拆出（行数棘轮）。
import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, Copy, FolderOpen, History, Loader2 } from "lucide-react";
import { open as openDirDialog } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import type { AcpChatHistoryEntry, AcpEngineInfo } from "@/types/agentChat";
import { agentChatService } from "@/services/agentChatService";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { handleErrorSilent } from "@/utils/errorHandler";

function formatHistoryTime(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return "";
  }
}

export interface EnginePickerProps {
  chatId: string;
  cwd: string;
  onPickCwd: (cwd: string) => void;
  /** 续接历史会话时采用该会话的 cwd（供后续 restart 使用）。 */
  onCwdAdopted: (cwd: string) => void;
}

export default function EnginePicker({ chatId, cwd, onPickCwd, onCwdAdopted }: EnginePickerProps) {
  const { t } = useTranslation("panes");
  const [engines, setEngines] = useState<AcpEngineInfo[] | null>(null);
  const [history, setHistory] = useState<AcpChatHistoryEntry[]>([]);
  const [historyFilter, setHistoryFilter] = useState("");
  const [startingEngine, setStartingEngine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filteredHistory = useMemo(() => {
    const query = historyFilter.trim().toLowerCase();
    if (!query) return history;
    return history.filter((entry) =>
      [entry.title, entry.cwd, entry.engineId, entry.acpSessionId]
        .join("\n")
        .toLowerCase()
        .includes(query),
    );
  }, [history, historyFilter]);

  useEffect(() => {
    let cancelled = false;
    agentChatService
      .listEngines()
      .then((list) => {
        if (!cancelled) setEngines(list);
      })
      .catch((listError) => {
        handleErrorSilent(listError, "list acp engines");
        if (!cancelled) setEngines([]);
      });
    agentChatService
      .listHistory()
      .then((entries) => {
        if (!cancelled) setHistory(entries.filter((entry) => entry.acpSessionId));
      })
      .catch((historyError) => {
        handleErrorSilent(historyError, "list acp chat history");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pickCwd = useCallback(async () => {
    const picked = await openDirDialog({ multiple: false, directory: true }).catch(() => null);
    if (typeof picked === "string" && picked) onPickCwd(picked);
  }, [onPickCwd]);

  const start = useCallback(
    async (engineId: string, startCwd: string, resumeAcpSessionId?: string) => {
      if (!startCwd) return;
      setError(null);
      setStartingEngine(resumeAcpSessionId ?? engineId);
      try {
        const snapshot = await agentChatService.start(
          chatId,
          engineId,
          startCwd,
          resumeAcpSessionId,
        );
        useAgentChatStore.getState().setSnapshot(chatId, snapshot);
        if (resumeAcpSessionId) onCwdAdopted(startCwd);
      } catch (startError) {
        setError(startError instanceof Error ? startError.message : String(startError));
      } finally {
        setStartingEngine(null);
      }
    },
    [chatId, onCwdAdopted],
  );

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 overflow-y-auto px-6 py-6">
      <Bot className="h-10 w-10 opacity-30" />
      <div className="text-sm text-[var(--app-icon-inactive)]">{t("agentChatPickEngine")}</div>
      {cwd ? (
        <div className="flex max-w-md items-center gap-2 text-xs text-[var(--app-icon-inactive)]">
          <span className="truncate font-mono" title={cwd}>
            {cwd}
          </span>
          <button
            type="button"
            className="shrink-0 rounded border border-[var(--app-border)] px-1.5 py-0.5 transition-colors hover:bg-[var(--app-hover)]"
            onClick={() => void pickCwd()}
          >
            {t("agentChatChangeCwd")}
          </button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2">
          <div className="max-w-md text-center text-xs text-[var(--app-icon-inactive)]">
            {t("agentChatNoProject")}
          </div>
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-md border border-[var(--app-border)] px-3 py-1.5 text-sm transition-colors hover:bg-[var(--app-hover)]"
            onClick={() => void pickCwd()}
          >
            <FolderOpen className="h-4 w-4" /> {t("agentChatPickCwd")}
          </button>
        </div>
      )}
      <div className="flex w-full max-w-sm flex-col gap-2">
        {engines === null ? (
          <div className="flex justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-[var(--app-icon-inactive)]" />
          </div>
        ) : (
          engines.map((engine) => (
            <button
              key={engine.id}
              type="button"
              disabled={startingEngine !== null || !cwd}
              className="flex items-center justify-between rounded-md border border-[var(--app-border)] px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--app-hover)] disabled:opacity-50"
              onClick={() => void start(engine.id, cwd)}
            >
              <span>{engine.label}</span>
              {startingEngine === engine.id ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : engine.available ? (
                <span className="text-[11px] text-[var(--app-status-success)]">●</span>
              ) : (
                <span
                  className="text-[11px] text-[var(--app-icon-inactive)]"
                  title={engine.requirement}
                >
                  {t("agentChatUnavailableEngine")}
                </span>
              )}
            </button>
          ))
        )}
      </div>
      {history.length > 0 ? (
        <div className="flex w-full max-w-sm flex-col gap-1.5">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--app-icon-inactive)]">
            <History className="h-3.5 w-3.5" /> {t("agentChatHistoryTitle")}
            <span className="flex-1" />
            <input
              value={historyFilter}
              onChange={(event) => setHistoryFilter(event.target.value)}
              placeholder={t("agentChatHistoryFilter")}
              className="w-32 rounded border border-[var(--app-border)] bg-transparent px-1.5 py-0.5 text-[11px] outline-none focus:border-[var(--app-icon-active)]"
            />
          </div>
          <div className="flex max-h-64 flex-col gap-1.5 overflow-y-auto">
            {filteredHistory.slice(0, 30).map((entry) => (
              <div
                key={entry.acpSessionId}
                className="group flex items-center gap-1 rounded-md border border-[var(--app-border)] px-2 py-1.5 transition-colors hover:bg-[var(--app-hover)]"
              >
                <button
                  type="button"
                  disabled={startingEngine !== null}
                  className="flex min-w-0 flex-1 flex-col gap-0.5 text-left disabled:opacity-50"
                  onClick={() => void start(entry.engineId, entry.cwd, entry.acpSessionId)}
                >
                  <span className="flex items-center gap-2">
                    <span className="flex-1 truncate text-xs">
                      {entry.title || entry.acpSessionId}
                    </span>
                    {startingEngine === entry.acpSessionId ? (
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
      ) : null}
      {startingEngine ? (
        <div className="text-xs text-[var(--app-icon-inactive)]">{t("agentChatStarting")}</div>
      ) : null}
      {error ? (
        <div className="max-w-md whitespace-pre-wrap break-all text-center text-xs text-[var(--app-status-danger)]">
          {t("agentChatStartFailed")}: {error}
        </div>
      ) : null}
    </div>
  );
}
