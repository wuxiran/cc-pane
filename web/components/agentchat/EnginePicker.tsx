// agent-chat 启动页：居中 hero 问候 + 建议卡 + composer 式启动栏（引擎下拉 +
// 首条 prompt 随启动发送）+ 最近会话续接。风格对标 CodexHost 的多引擎首页。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Bot,
  Bug,
  ChevronDown,
  FolderOpen,
  GitBranch,
  Hammer,
  Loader2,
  SearchCode,
  Telescope,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AcpChatHistoryEntry, AcpEngineInfo } from "@/types/agentChat";
import { agentChatService } from "@/services/agentChatService";
import { gitService } from "@/services/gitService";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { handleErrorSilent } from "@/utils/errorHandler";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import ChatVoiceButton from "./ChatVoiceButton";
import PermissionPolicyDropdown from "./PermissionPolicyDropdown";
import StartPrefDropdown from "./StartPrefDropdown";
import StartProjectMenu, { projectNameOf } from "./StartProjectMenu";
import StartRecentSessions from "./StartRecentSessions";
import { takePendingResume } from "./pendingResume";
import {
  loadAutoApproveKinds,
  loadEnginePrefs,
  saveAutoApproveKinds,
  saveEngineModels,
  saveEngineModes,
  savePreferredMode,
  savePreferredModel,
  type EngineModelPrefs,
} from "./enginePrefs";

const SUGGESTIONS = [
  { icon: Telescope, labelKey: "agentChatSuggestExplore", promptKey: "agentChatSuggestExplorePrompt" },
  { icon: Hammer, labelKey: "agentChatSuggestBuild", promptKey: "agentChatSuggestBuildPrompt" },
  { icon: SearchCode, labelKey: "agentChatSuggestReview", promptKey: "agentChatSuggestReviewPrompt" },
  { icon: Bug, labelKey: "agentChatSuggestFix", promptKey: "agentChatSuggestFixPrompt" },
] as const;

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
  const [startingEngine, setStartingEngine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modelPrefs, setModelPrefs] = useState<EngineModelPrefs | null>(null);
  const [autoApproveKinds, setAutoApproveKinds] = useState<string[]>([]);
  const [branch, setBranch] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // 分支 chip（只读展示；非 git 目录静默无 chip）。
  useEffect(() => {
    if (!cwd) {
      setBranch(null);
      return;
    }
    let cancelled = false;
    gitService
      .getRepoInfo(cwd)
      .then((info) => {
        if (!cancelled) setBranch(info.state === "ok" ? info.branch : null);
      })
      .catch(() => setBranch(null));
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  // 模型表来自该引擎上次会话的握手缓存；首次使用时为空（下拉不显示）。
  useEffect(() => {
    setModelPrefs(selectedEngine ? loadEnginePrefs(selectedEngine) : null);
    setAutoApproveKinds(selectedEngine ? loadAutoApproveKinds(selectedEngine) : []);
  }, [selectedEngine]);

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
    return () => {
      cancelled = true;
    };
  }, []);

  const loadHistory = useCallback(() => {
    agentChatService
      .listHistory()
      .then((entries) => setHistory(entries.filter((entry) => entry.acpSessionId)))
      .catch((historyError) => {
        handleErrorSilent(historyError, "list acp chat history");
      });
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // 侧栏「最近会话」开出来的标签：领取续接意图，跳过选择页直接 start。
  useEffect(() => {
    const entry = takePendingResume(chatId);
    if (entry) void start(entry.engineId, entry.cwd, entry.acpSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

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
          loadAutoApproveKinds(engineId),
        );
        useAgentChatStore.getState().setSnapshot(chatId, snapshot);
        if (resumeAcpSessionId) onCwdAdopted(startCwd);
        // 回填该引擎的模型/模式表缓存；有偏好且与当前不同则自动应用。
        const models = snapshot.models?.availableModels ?? [];
        const modes = snapshot.modes?.availableModes ?? [];
        saveEngineModels(engineId, models);
        saveEngineModes(engineId, modes);
        const prefs = loadEnginePrefs(engineId);
        const preferred = prefs?.preferredModelId;
        if (
          preferred
          && preferred !== snapshot.models?.currentModelId
          && models.some((model) => model.modelId === preferred)
        ) {
          void agentChatService.setModel(chatId, preferred).catch((modelError) => {
            handleErrorSilent(modelError, "apply preferred acp model");
          });
        }
        const preferredMode = prefs?.preferredModeId;
        if (
          preferredMode
          && preferredMode !== snapshot.modes?.currentModeId
          && modes.some((mode) => mode.id === preferredMode)
        ) {
          void agentChatService.setMode(chatId, preferredMode).catch((modeError) => {
            handleErrorSilent(modeError, "apply preferred acp mode");
          });
        }
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

  const launching = startingEngine !== null && startingEngine === selectedEngine;

  return (
    <div className="flex h-full flex-col overflow-y-auto px-6">
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-7 py-10">
        {/* Hero：问候语，项目名做强调下划线（无项目时引导选目录） */}
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--app-active-bg)] text-[var(--app-accent)]">
            <Bot className="h-6 w-6" />
          </div>
          <h2 className="text-2xl font-semibold leading-snug tracking-tight text-[var(--app-text-primary)]">
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
          {projectName ? (
            <p className="text-[13px] text-[var(--app-text-tertiary)]">{t("agentChatHeroSub")}</p>
          ) : null}
        </div>
        {!cwd ? (
          <div className="flex justify-center">
            <StartProjectMenu
              cwd={cwd}
              onPickCwd={onPickCwd}
              trigger={
                <button
                  type="button"
                  className="flex items-center gap-1.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-overlay)] px-3.5 py-2 text-sm shadow-sm transition-colors hover:bg-[var(--app-hover)]"
                >
                  <FolderOpen className="h-4 w-4" /> {t("agentChatPickCwd")}
                  <ChevronDown className="h-3.5 w-3.5 text-[var(--app-text-tertiary)]" />
                </button>
              }
            />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            {SUGGESTIONS.map(({ icon: Icon, labelKey, promptKey }) => (
              <button
                key={labelKey}
                type="button"
                className="group flex flex-col items-start gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-overlay)] px-3.5 py-3.5 text-left text-[13px] leading-snug text-[var(--app-text-secondary)] shadow-sm transition-[color,border-color,box-shadow,transform] duration-[var(--dur)] ease-[var(--ease-out)] hover:-translate-y-px hover:border-[var(--app-accent)]/50 hover:shadow-md hover:text-[var(--app-text-primary)]"
                onClick={() => {
                  setDraft(t(promptKey));
                  textareaRef.current?.focus();
                }}
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--app-active-bg)] text-[var(--app-accent)]">
                  <Icon className="h-4 w-4" />
                </span>
                {t(labelKey)}
              </button>
            ))}
          </div>
        )}

        {/* Composer 式启动栏：chips 行 + 输入 + 引擎/模型/模式/权限 + 发送 */}
        <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-chat-composer-bg)] px-3 pb-2 pt-2.5 shadow-sm transition-[border-color,box-shadow] duration-[var(--dur)] ease-[var(--ease-out)] focus-within:border-[var(--app-accent)]/70 focus-within:shadow-[0_0_0_3px_var(--app-active-bg)]">
          {cwd ? (
            <div className="mb-2 flex items-center gap-1.5 text-[11px] text-[var(--app-text-tertiary)]">
              <StartProjectMenu
                cwd={cwd}
                onPickCwd={onPickCwd}
                trigger={
                  <button
                    type="button"
                    title={cwd}
                    className="flex items-center gap-1 rounded-md border border-[var(--app-border)] bg-[var(--app-overlay)] px-1.5 py-0.5 font-mono text-[var(--app-text-secondary)] transition-colors hover:text-[var(--app-text-primary)]"
                  >
                    <FolderOpen className="h-3 w-3 shrink-0" />
                    <span className="max-w-64 truncate">{projectName}</span>
                    <ChevronDown className="h-2.5 w-2.5" />
                  </button>
                }
              />
              {branch ? (
                <span className="flex items-center gap-1 rounded-md border border-[var(--app-border)] bg-[var(--app-overlay)] px-1.5 py-0.5 font-mono">
                  <GitBranch className="h-3 w-3 shrink-0" />
                  <span className="max-w-40 truncate">{branch}</span>
                </span>
              ) : null}
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
            rows={3}
            className="max-h-48 w-full resize-none bg-transparent text-sm leading-relaxed text-[var(--app-text-primary)] outline-none placeholder:text-[var(--app-text-tertiary)]"
          />
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    disabled={engines === null || engines.length === 0}
                    className="flex h-7 items-center gap-1.5 rounded-md border border-[var(--app-border)] bg-[var(--app-overlay)] px-2 text-xs font-medium text-[var(--app-text-primary)] shadow-sm transition-colors hover:border-[var(--app-accent)]/50 disabled:opacity-50"
                  >
                    {engines === null ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <>
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            selected?.available
                              ? "bg-[var(--app-status-success)]"
                              : "bg-[var(--app-text-tertiary)]"
                          }`}
                        />
                        {selected?.label ?? t("agentChatPickEngine")}
                      </>
                    )}
                    <ChevronDown className="h-3 w-3 text-[var(--app-text-tertiary)]" />
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
                            : "bg-[var(--app-text-tertiary)]"
                        }`}
                      />
                      {engine.label}
                      {!engine.available ? (
                        <span className="ml-2 text-[10px] text-[var(--app-text-tertiary)]">
                          {t("agentChatUnavailableEngine")}
                        </span>
                      ) : null}
                      {engine.id === selectedEngine ? (
                        <span className="ml-auto pl-3 text-[var(--app-accent)]">✓</span>
                      ) : null}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <StartPrefDropdown
                items={(modelPrefs?.models ?? []).map((model) => ({
                  id: model.modelId,
                  label: model.name || model.modelId,
                  description: model.description,
                }))}
                currentId={modelPrefs?.preferredModelId ?? null}
                defaultLabel={t("agentChatModelDefault")}
                onSelect={(modelId) => {
                  if (!selectedEngine) return;
                  savePreferredModel(selectedEngine, modelId);
                  setModelPrefs(loadEnginePrefs(selectedEngine));
                }}
              />
              <StartPrefDropdown
                items={(modelPrefs?.modes ?? []).map((mode) => ({
                  id: mode.id,
                  label: mode.name || mode.id,
                  description: mode.description,
                }))}
                currentId={modelPrefs?.preferredModeId ?? null}
                defaultLabel={t("agentChatModeDefault")}
                onSelect={(modeId) => {
                  if (!selectedEngine) return;
                  savePreferredMode(selectedEngine, modeId);
                  setModelPrefs(loadEnginePrefs(selectedEngine));
                }}
              />
              <PermissionPolicyDropdown
                kinds={autoApproveKinds}
                disabled={!selectedEngine}
                onChange={(kinds) => {
                  if (!selectedEngine) return;
                  saveAutoApproveKinds(selectedEngine, kinds);
                  setAutoApproveKinds(kinds);
                }}
              />
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <ChatVoiceButton
                chatId={chatId}
                variant="ghost"
                onText={(text) =>
                  setDraft((previous) => (previous ? `${previous} ${text}` : text))
                }
              />
              <IconTooltipButton
                label={t("agentChatSend")}
                kbd="Enter"
                disabled={!cwd || !selectedEngine || startingEngine !== null}
                className="h-7 w-7 rounded-full bg-[var(--app-accent)] text-white hover:bg-[var(--app-accent)] hover:text-white hover:opacity-90 disabled:opacity-35"
                onClick={launch}
              >
                {launching ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
                )}
              </IconTooltipButton>
            </div>
          </div>
        </div>

        {error ? (
          <div className="whitespace-pre-wrap break-all rounded-lg border border-[var(--app-status-danger-border)] bg-[var(--app-status-danger-bg)] px-3 py-2 text-center text-xs text-[var(--app-status-danger)]">
            {t("agentChatStartFailed")}: {error}
          </div>
        ) : null}
      </div>

      {/* 最近会话：紧凑列表，点击续接（session/load） */}
      <StartRecentSessions
        entries={history}
        cwd={cwd}
        startingId={startingEngine}
        onResume={(entry) => void start(entry.engineId, entry.cwd, entry.acpSessionId)}
        onMutate={loadHistory}
      />
    </div>
  );
}
