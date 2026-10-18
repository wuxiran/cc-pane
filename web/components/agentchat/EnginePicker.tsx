// agent-chat 启动页：居中 hero 问候 + 建议入口 + composer 式启动栏（引擎下拉 +
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
import { useWorkspacesStore } from "@/stores/useWorkspacesStore";
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
import StartProjectMenu, { workspaceLabelFor } from "./StartProjectMenu";
import StartRecentSessions from "./StartRecentSessions";
import { takePendingResume } from "./pendingResume";
import { takePendingStart } from "./pendingStart";
import {
  loadAutoApproveKinds,
  loadEnginePrefs,
  loadPreferredConfigOptions,
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
  // 首页「对 agent 说」开出来的标签：领取启动意图，带首条消息直接 start。
  useEffect(() => {
    const resume = takePendingResume(chatId);
    if (resume) {
      void start(resume.engineId, resume.cwd, resume.acpSessionId);
      return;
    }
    const launch = takePendingStart(chatId);
    if (launch) {
      onCwdAdopted(launch.cwd);
      if (launch.preamble) useAgentChatStore.getState().setConcierge(chatId, true);
      void start(launch.engineId, launch.cwd, undefined, launch.firstPrompt, launch.preamble);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  /**
   * 启动会话；firstPrompt 非空时启动成功后立即作为首条消息发送。
   * preamble 只发给引擎、不进对话画面（管家角色指令等）。
   */
  const start = useCallback(
    async (
      engineId: string,
      startCwd: string,
      resumeAcpSessionId?: string,
      firstPrompt?: string,
      preamble?: string,
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
        // 新会话同样要登记 cwd：顶栏工作空间 chip、restart、@引用相对路径都靠它
        // （此前只有续接路径登记，手动启动的会话 chip 直接隐身）。
        onCwdAdopted(startCwd);
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
        // 配置项偏好（思维深度等）：只对 agent 本次仍广告、且值仍在选项里的项应用。
        const preferredOptions = loadPreferredConfigOptions(engineId);
        for (const option of snapshot.configOptions ?? []) {
          const wanted = preferredOptions[option.configId];
          if (
            wanted === undefined
            || option.category === "mode"
            || option.category === "model"
            || option.currentValue === wanted
            || !(option.options ?? []).some((choice) => choice.value === wanted)
          ) {
            continue;
          }
          void agentChatService.setConfigOption(chatId, option.configId, wanted).catch((optionError) => {
            handleErrorSilent(optionError, "apply preferred acp config option");
          });
        }
        const text = firstPrompt?.trim();
        if (text) {
          useAgentChatStore.getState().addUserMessage(chatId, text, []);
          // 单个文本块最稳：各引擎的 ACP 适配器对多块拼接行为不一致。
          const lead = preamble?.trim();
          const outbound = lead ? `${lead}\n\n---\n\n${text}` : text;
          void agentChatService.prompt(chatId, [{ type: "text", text: outbound }]).catch((promptError) => {
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
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  // 常驻工作空间显示产品名（Agent Chat），普通目录退回目录名
  const projectName = cwd ? workspaceLabelFor(cwd, workspaces) : null;

  const launching = startingEngine !== null && startingEngine === selectedEngine;

  return (
    <div className="agent-chat-start-page flex h-full flex-col overflow-y-auto px-6">
      <div className="agent-chat-start-content mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-8 py-12">
        {/* Hero：问候语与项目名（无项目时引导选目录） */}
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="mb-1 flex h-11 w-11 items-center justify-center text-[var(--app-text-secondary)]">
            <Bot className="h-7 w-7" strokeWidth={1.5} />
          </div>
          <h2 className="max-w-full break-words text-[28px] font-medium leading-snug tracking-tight text-[var(--app-text-primary)]">
            {projectName ? (
              <>
                {t("agentChatHeroBefore")}
                <span className="text-[var(--app-text-primary)]">
                  {projectName}
                </span>
                {t("agentChatHeroAfter")}
              </>
            ) : (
              t("agentChatNoProject")
            )}
          </h2>
          {projectName ? (
            <p className="text-sm leading-relaxed text-[var(--app-text-tertiary)]">{t("agentChatHeroSub")}</p>
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
                  className="flex items-center gap-2 rounded-full border border-[var(--app-border)] px-4 py-2.5 text-sm text-[var(--app-text-secondary)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
                >
                  <FolderOpen className="h-4 w-4" /> {t("agentChatPickCwd")}
                  <ChevronDown className="h-3.5 w-3.5 text-[var(--app-text-tertiary)]" />
                </button>
              }
            />
          </div>
        ) : (
          <div className="flex flex-wrap justify-center gap-1.5">
            {SUGGESTIONS.map(({ icon: Icon, labelKey, promptKey }) => (
              <button
                key={labelKey}
                type="button"
                className="flex items-center gap-2 rounded-full px-3.5 py-2 text-[13px] leading-snug text-[var(--app-text-secondary)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
                onClick={() => {
                  setDraft(t(promptKey));
                  textareaRef.current?.focus();
                }}
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--app-text-tertiary)]">
                  <Icon className="h-4 w-4" />
                </span>
                {t(labelKey)}
              </button>
            ))}
          </div>
        )}

        {/* Composer 式启动栏：chips 行 + 输入 + 引擎/模型/模式/权限 + 发送 */}
        <div className="agent-chat-start-composer agent-chat-composer-shell rounded-3xl border border-[var(--app-border)] bg-[var(--app-chat-composer-bg)] px-4 pb-3 pt-4 transition-[border-color,box-shadow] duration-[var(--dur)] ease-[var(--ease-out)] focus-within:border-[var(--app-text-tertiary)]">
          {cwd ? (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-[var(--app-text-tertiary)]">
              <StartProjectMenu
                cwd={cwd}
                onPickCwd={onPickCwd}
                trigger={
                  <button
                    type="button"
                    title={cwd}
                    className="flex min-w-0 max-w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-[var(--app-text-secondary)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
                  >
                    <FolderOpen className="h-3 w-3 shrink-0" />
                    <span className="min-w-0 max-w-64 truncate">{projectName}</span>
                    <ChevronDown className="h-2.5 w-2.5" />
                  </button>
                }
              />
              {branch ? (
                <span className="flex min-w-0 max-w-full items-center gap-1.5 rounded-lg px-1.5 py-1">
                  <GitBranch className="h-3 w-3 shrink-0" />
                  <span className="min-w-0 max-w-40 truncate">{branch}</span>
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
            className="agent-chat-composer-input max-h-48 min-h-[4.25rem] w-full resize-none bg-transparent text-[15px] leading-relaxed text-[var(--app-text-primary)] outline-none placeholder:text-[var(--app-text-tertiary)]"
          />
          <div className="agent-chat-composer-toolbar mt-3 flex items-end justify-between gap-3">
            <div className="agent-chat-composer-options flex min-w-0 flex-wrap items-center gap-1.5">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    disabled={engines === null || engines.length === 0}
                    className="flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-[var(--app-text-secondary)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)] disabled:opacity-50"
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
                        <span className="truncate">{selected?.label ?? t("agentChatPickEngine")}</span>
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
                        <span className="ml-auto pl-3 text-[var(--app-text-primary)]">✓</span>
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
            <div className="agent-chat-composer-actions flex shrink-0 items-center gap-1.5">
              <ChatVoiceButton
                chatId={chatId}
                variant="ghost"
                sizeClass="h-8 w-8 rounded-full"
                onText={(text) =>
                  setDraft((previous) => (previous ? `${previous} ${text}` : text))
                }
              />
              <IconTooltipButton
                label={t("agentChatSend")}
                kbd="Enter"
                disabled={!cwd || !selectedEngine || startingEngine !== null}
                className="h-8 w-8 rounded-full bg-[var(--app-text-primary)] text-[var(--app-panel-bg)] hover:bg-[var(--app-text-primary)] hover:text-[var(--app-panel-bg)] hover:opacity-85 disabled:opacity-30"
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
