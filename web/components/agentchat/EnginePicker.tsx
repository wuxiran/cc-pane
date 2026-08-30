// agent-chat 启动页：居中 hero 问候 + 建议卡 + composer 式启动栏（引擎下拉 +
// 首条 prompt 随启动发送）+ 最近会话续接。风格对标 CodexHost 的多引擎首页。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bug,
  ChevronDown,
  Copy,
  FolderOpen,
  Hammer,
  History,
  Loader2,
  SearchCode,
  Send,
  Telescope,
} from "lucide-react";
import { open as openDirDialog } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import type { AcpChatHistoryEntry, AcpEngineInfo } from "@/types/agentChat";
import { agentChatService } from "@/services/agentChatService";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { handleErrorSilent } from "@/utils/errorHandler";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const SUGGESTIONS = [
  { icon: Telescope, labelKey: "agentChatSuggestExplore", promptKey: "agentChatSuggestExplorePrompt" },
  { icon: Hammer, labelKey: "agentChatSuggestBuild", promptKey: "agentChatSuggestBuildPrompt" },
  { icon: SearchCode, labelKey: "agentChatSuggestReview", promptKey: "agentChatSuggestReviewPrompt" },
  { icon: Bug, labelKey: "agentChatSuggestFix", promptKey: "agentChatSuggestFixPrompt" },
] as const;

function formatHistoryTime(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return "";
  }
}

function projectNameOf(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
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
  const [selectedEngine, setSelectedEngine] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<AcpChatHistoryEntry[]>([]);
  const [historyFilter, setHistoryFilter] = useState("");
  const [startingEngine, setStartingEngine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

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
        if (cancelled) return;
        setEngines(list);
        setSelectedEngine(
          (previous) => previous ?? (list.find((engine) => engine.available) ?? list[0])?.id ?? null,
        );
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

  /** 启动会话；firstPrompt 非空时启动成功后立即作为首条消息发送。 */
  const start = useCallback(
    async (
      engineId: string,
      startCwd: string,
      resumeAcpSessionId?: string,
      firstPrompt?: string,
    ) => {
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
        const text = firstPrompt?.trim();
        if (text) {
          useAgentChatStore.getState().addUserMessage(chatId, text, []);
          void agentChatService.prompt(chatId, [{ type: "text", text }]).catch((promptError) => {
            useAgentChatStore
              .getState()
              .pushNotice(
                chatId,
                promptError instanceof Error ? promptError.message : String(promptError),
              );
          });
        }
      } catch (startError) {
        setError(startError instanceof Error ? startError.message : String(startError));
      } finally {
        setStartingEngine(null);
      }
    },
    [chatId, onCwdAdopted],
  );

  const launch = useCallback(() => {
    if (!cwd || !selectedEngine || startingEngine !== null) return;
    void start(selectedEngine, cwd, undefined, draft);
  }, [cwd, selectedEngine, startingEngine, start, draft]);

  const selected = engines?.find((engine) => engine.id === selectedEngine) ?? null;
  const projectName = cwd ? projectNameOf(cwd) : null;

  return (
    <div className="flex h-full flex-col overflow-y-auto px-6">
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 py-10">
        {/* Hero：问候语，项目名做强调下划线（无项目时引导选目录） */}
        <h2 className="text-center text-xl font-medium leading-relaxed">
          {projectName ? (
            <>
              {t("agentChatHeroBefore")}
              <span className="text-[var(--app-accent)] underline decoration-[var(--app-accent)]/40 decoration-2 underline-offset-4">
                {projectName}
              </span>
              {t("agentChatHeroAfter")}
            </>
          ) : (
            t("agentChatNoProject")
          )}
        </h2>
        {!cwd ? (
          <div className="flex justify-center">
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-md border border-[var(--app-border)] px-3 py-1.5 text-sm transition-colors hover:bg-[var(--app-hover)]"
              onClick={() => void pickCwd()}
            >
              <FolderOpen className="h-4 w-4" /> {t("agentChatPickCwd")}
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {SUGGESTIONS.map(({ icon: Icon, labelKey, promptKey }) => (
              <button
                key={labelKey}
                type="button"
                className="flex flex-col items-start gap-2 rounded-lg border border-[var(--app-border)] px-3 py-3 text-left text-xs leading-snug transition-colors hover:border-[var(--app-accent)]/50 hover:bg-[var(--app-hover)]"
                onClick={() => {
                  setDraft(t(promptKey));
                  textareaRef.current?.focus();
                }}
              >
                <Icon className="h-4 w-4 text-[var(--app-accent)]" />
                {t(labelKey)}
              </button>
            ))}
          </div>
        )}

        {/* Composer 式启动栏：chips 行 + 输入 + 引擎下拉 + 发送 */}
        <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-3 py-2.5 shadow-sm focus-within:border-[var(--app-accent)]/60">
          {cwd ? (
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-[var(--app-icon-inactive)]">
              <FolderOpen className="h-3 w-3 shrink-0" />
              <span className="max-w-[50%] truncate font-mono" title={cwd}>
                {projectName}
              </span>
              <button
                type="button"
                className="rounded border border-[var(--app-border)] px-1.5 py-px transition-colors hover:bg-[var(--app-hover)]"
                onClick={() => void pickCwd()}
              >
                {t("agentChatChangeCwd")}
              </button>
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                launch();
              }
            }}
            placeholder={t("agentChatHeroPlaceholder")}
            rows={2}
            className="max-h-40 w-full resize-none bg-transparent text-sm outline-none placeholder:text-[var(--app-icon-inactive)]"
          />
          <div className="flex items-center justify-between gap-2 pt-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  disabled={engines === null || engines.length === 0}
                  className="flex items-center gap-1.5 rounded-md border border-[var(--app-border)] px-2 py-1 text-xs transition-colors hover:bg-[var(--app-hover)] disabled:opacity-50"
                >
                  {engines === null ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <>
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          selected?.available
                            ? "bg-[var(--app-status-success)]"
                            : "bg-[var(--app-icon-inactive)]"
                        }`}
                      />
                      {selected?.label ?? t("agentChatPickEngine")}
                    </>
                  )}
                  <ChevronDown className="h-3 w-3 text-[var(--app-icon-inactive)]" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {(engines ?? []).map((engine) => (
                  <DropdownMenuItem
                    key={engine.id}
                    disabled={!engine.available}
                    title={engine.available ? undefined : engine.requirement}
                    onSelect={() => setSelectedEngine(engine.id)}
                  >
                    <span
                      className={`mr-2 h-1.5 w-1.5 rounded-full ${
                        engine.available
                          ? "bg-[var(--app-status-success)]"
                          : "bg-[var(--app-icon-inactive)]"
                      }`}
                    />
                    {engine.label}
                    {engine.id === selectedEngine ? (
                      <span className="ml-auto pl-3 text-[var(--app-accent)]">✓</span>
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              type="button"
              aria-label={t("agentChatSend")}
              disabled={!cwd || !selectedEngine || startingEngine !== null}
              className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--app-accent)] text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              onClick={launch}
            >
              {startingEngine !== null && startingEngine === selectedEngine ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>

        {error ? (
          <div className="whitespace-pre-wrap break-all text-center text-xs text-[var(--app-status-danger)]">
            {t("agentChatStartFailed")}: {error}
          </div>
        ) : null}
      </div>

      {/* 最近会话：紧凑列表，点击续接（session/load） */}
      {history.length > 0 ? (
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-1.5 pb-6">
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
          <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto">
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
    </div>
  );
}
