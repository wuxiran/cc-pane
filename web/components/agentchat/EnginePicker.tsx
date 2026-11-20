// agent-chat 启动页：居中 hero 问候 + 建议入口 + composer 式启动栏（引擎下拉 +
// 首条 prompt 随启动发送）+ 最近会话续接。风格对标 CodexHost 的多引擎首页。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  FolderOpen,
  Loader2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import logoUrl from "@/assets/logo.svg";
import type { AcpChatHistoryEntry, AcpEngineInfo } from "@/types/agentChat";
import { agentChatService, type AcpRemoteLaunch } from "@/services/agentChatService";
import type { LocalWorktreeDraft } from "@/types/localLaunch";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { useAgentChatRemoteStore } from "@/stores/useAgentChatRemoteStore";
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
import StartTray from "./StartTray";
import { remoteLaunchOf, selectRemoteMachine } from "./remoteTarget";
import CompactStartPage from "./CompactStartPage";
import { takePendingResume } from "./pendingResume";
import { takePendingStart } from "./pendingStart";
import { usePendingDraft } from "./pendingDraft";
import { startConfiguredChat } from "./startConfiguredChat";
import "@/i18n/codexIntegrationResources";
import { CODEX_APP_SERVER_ENGINE, codexEngineLabel } from "@/lib/codexIntegration";
import {
  loadAutoApproveKinds,
  loadEnginePrefs,
  saveAutoApproveKinds,
  savePreferredMode,
  savePreferredModel,
  type EngineModelPrefs,
} from "./enginePrefs";


export interface EnginePickerProps {
  chatId: string;
  preferredEngineId?: string;
  cwd: string;
  onPickCwd: (cwd: string) => void;
  /** 续接历史会话时采用该会话的 cwd（供后续 restart 使用）。 */
  onCwdAdopted: (cwd: string) => void;
  /** 右侧面板窄版：只留输入框（项目 / 引擎 / 权限 / 发送），贴底。 */
  compact?: boolean;
}

export default function EnginePicker({ chatId, preferredEngineId, cwd, onPickCwd, onCwdAdopted, compact = false }: EnginePickerProps) {
  const { t } = useTranslation("panes");
  const { t: codexT } = useTranslation("codexIntegration");
  // 远程目标按对话存：启动页选的机器，restart/重试沿用（AgentChatTabContent 读同一份）。
  const remote = useAgentChatRemoteStore((state) => state.targets[chatId] ?? null);
  const [engines, setEngines] = useState<AcpEngineInfo[] | null>(null);
  const [selectedEngine, setSelectedEngine] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<AcpChatHistoryEntry[]>([]);
  const [startingEngine, setStartingEngine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modelPrefs, setModelPrefs] = useState<EngineModelPrefs | null>(null);
  const [autoApproveKinds, setAutoApproveKinds] = useState<string[]>([]);
  const [worktree, setWorktree] = useState<LocalWorktreeDraft | undefined>();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  usePendingDraft(chatId, setDraft, textareaRef);
  const pickCwd = useCallback((nextCwd: string) => {
    if (useAgentChatStore.getState().chats[chatId]?.setup?.pending) return;
    onPickCwd(nextCwd);
  }, [chatId, onPickCwd]);

  // A project change starts a fresh local launch draft; it cannot reuse another repo's ref.
  useEffect(() => {
    setWorktree(undefined);
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
        const defaultEngine = list.find((engine) => engine.available && engine.id !== CODEX_APP_SERVER_ENGINE)
          ?? list.find((engine) => engine.available) ?? list[0];
        setSelectedEngine(
          (previous) => previous ?? preferredEngineId ?? defaultEngine?.id ?? null,
        );
      })
      .catch((listError) => {
        handleErrorSilent(listError, "list acp engines");
        if (!cancelled) setEngines([]);
      });
    return () => {
      cancelled = true;
    };
  }, [preferredEngineId]);

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
      launchWorktree?: LocalWorktreeDraft,
      launchRemote?: AcpRemoteLaunch,
    ) => {
      if (!startCwd || useAgentChatStore.getState().chats[chatId]?.setup?.pending) return;
      // 续接/首页交接都是本地会话；残留的远程选择不能让画面误标成远程。
      if (!launchRemote) selectRemoteMachine(chatId, null);
      setError(null);
      setStartingEngine(resumeAcpSessionId ?? engineId);
      try {
        await startConfiguredChat({
          chatId, engineId, cwd: startCwd, resumeAcpSessionId, firstPrompt, preamble,
          onCwdAdopted,
          worktree: launchWorktree,
          remote: launchRemote,
        });
      } catch (startError) {
        setError(startError instanceof Error ? startError.message : String(startError));
      } finally {
        setStartingEngine(null);
      }
    },
    [chatId, onCwdAdopted],
  );

  const remoteChecking = remote?.probe.status === "checking";
  const launch = useCallback(() => {
    if (!cwd || !selectedEngine || !engines?.some((engine) => engine.id === selectedEngine && engine.available) || startingEngine !== null) return;
    if (!remote) {
      void start(selectedEngine, cwd, undefined, draft, undefined, worktree);
      return;
    }
    if (remoteChecking) return;
    const remoteCwd = remote.cwd.trim() || "~";
    if (remoteCwd !== remote.cwd) useAgentChatRemoteStore.getState().setRemoteCwd(chatId, remoteCwd);
    void start(selectedEngine, remoteCwd, undefined, draft, undefined, undefined, remoteLaunchOf(remote));
  }, [chatId, cwd, engines, selectedEngine, startingEngine, start, draft, worktree, remote, remoteChecking]);

  const selected = engines?.find((engine) => engine.id === selectedEngine) ?? null;
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  // 常驻工作空间显示产品名（Agent Chat），普通目录退回目录名
  const remoteLabel = remote ? t("agentChatRemoteTarget", { machine: remote.machineName, path: remote.cwd.trim() || "~" }) : null;
  const projectName = remoteLabel ?? (cwd ? workspaceLabelFor(cwd, workspaces) : null);

  const launching = startingEngine !== null && startingEngine === selectedEngine;

  const engineMenu = (
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
                        <span className="truncate">{selected ? codexEngineLabel(selected.id, selected.label) : t("agentChatPickEngine")}</span>
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
                      {codexEngineLabel(engine.id, engine.label)}
                      {!engine.available ? (
                        <span className="ml-2 text-[length:var(--text-micro)] text-[var(--app-text-tertiary)]">
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
  );
  const modelMenu = (
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
  );
  const modeMenu = (
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
  );
  const permissionMenu = (
              <PermissionPolicyDropdown
                kinds={autoApproveKinds}
                disabled={!selectedEngine}
                onChange={(kinds) => {
                  if (!selectedEngine) return;
                  saveAutoApproveKinds(selectedEngine, kinds);
                  setAutoApproveKinds(kinds);
                }}
              />
  );
  const voiceButton = (
              <ChatVoiceButton
                chatId={chatId}
                variant="ghost"
                sizeClass="h-8 w-8 rounded-full"
                onText={(text) =>
                  setDraft((previous) => (previous ? `${previous} ${text}` : text))
                }
              />
  );
  const sendButton = (
              <IconTooltipButton
                label={t("agentChatSend")}
                kbd="Enter"
                disabled={!cwd || !selected?.available || startingEngine !== null || remoteChecking}
                className="h-8 w-8 rounded-full bg-[var(--app-text-primary)] text-[var(--app-panel-bg)] hover:bg-[var(--app-text-primary)] hover:text-[var(--app-panel-bg)] hover:opacity-85 disabled:opacity-30"
                onClick={launch}
              >
                {launching ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
                )}
              </IconTooltipButton>
  );
  // 远程目标：项目位只显示「机器 · 远端目录」，不挂本地项目选择。
  const projectMenu = (trigger: React.ReactElement) => remote
    ? <span data-testid="remote-target-label" title={t("agentChatRemoteTargetTip", { host: remote.host, path: remote.cwd })}>{remoteLabel}</span>
    : <StartProjectMenu cwd={cwd} onPickCwd={pickCwd} trigger={trigger} />;
  if (compact) {
    return (
      <CompactStartPage
        projectName={projectName}
        cwd={cwd}
        busy={startingEngine !== null}
        projectMenu={projectMenu}
        draft={draft}
        onDraft={setDraft}
        onSubmit={launch}
        textareaRef={textareaRef}
        placeholder={t("agentChatCompactPlaceholder")}
        permissionMenu={permissionMenu}
        engineMenu={engineMenu}
        modelMenu={modelMenu}
        voiceButton={voiceButton}
        sendButton={sendButton}
        notice={selectedEngine && engines && !selected?.available ? (selected?.requirement || codexT("unavailable")) : null}
        error={error ? `${t("agentChatStartFailed")}: ${error}` : null}
      />
    );
  }
  return (
    <div className="agent-chat-start-page flex h-full flex-col overflow-y-auto px-4 sm:px-8">
      <div className="agent-chat-start-content mx-auto flex w-full max-w-3xl flex-1 flex-col">
        {/* Hero：垂直居中的 logo + 问话；项目名可点，直接换项目（ChatGPT / Codex 式） */}
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-1 py-10 text-center">
          <img src={logoUrl} alt="CC-Panes" draggable={false} className="size-12 rounded-xl" />
          {cwd && projectName ? (
            <h2 className="max-w-full break-words text-[length:var(--text-hero)] font-medium leading-snug tracking-tight text-[var(--app-text-primary)]">
              {t("agentChatHeroBefore")}
              {projectMenu(
                <button
                  type="button"
                  title={cwd}
                  disabled={startingEngine !== null}
                  className="underline decoration-[var(--app-text-tertiary)] decoration-dotted decoration-1 underline-offset-[6px] transition-colors hover:decoration-[var(--app-text-primary)]"
                >
                  {projectName}
                </button>,
              )}
              {t("agentChatHeroAfter")}
            </h2>
          ) : (
            <>
              <h2 className="text-[length:var(--text-hero)] font-medium leading-snug tracking-tight text-[var(--app-text-primary)]">
                {t("agentChatNoProject")}
              </h2>
              {projectMenu(
                <button
                  type="button"
                  className="flex items-center gap-2 rounded-full border border-[var(--app-border)] px-4 py-2 text-sm text-[var(--app-text-secondary)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
                >
                  <FolderOpen className="h-4 w-4" /> {t("agentChatPickCwd")}
                  <ChevronDown className="h-3.5 w-3.5 text-[var(--app-text-tertiary)]" />
                </button>,
              )}
            </>
          )}
        </div>

        {selectedEngine && engines && !selected?.available && <p role="status" className="mb-2 px-2 text-sm text-[var(--app-text-tertiary)]">{selected?.requirement || codexT("unavailable")}</p>}
        {error ? (
          <div className="mb-2 whitespace-pre-wrap break-all rounded-lg border border-[var(--app-status-danger-border)] bg-[var(--app-status-danger-bg)] px-3 py-2 text-xs text-[var(--app-status-danger)]">
            {t("agentChatStartFailed")}: {error}
          </div>
        ) : null}

        {/* 底部输入区：上方托盘挂运行位置 / 项目 / 审查，下方输入卡挂权限、引擎、模型、发送 */}
        <div className="agent-chat-start-dock pb-4">
          {cwd ? (
            <StartTray chatId={chatId} cwd={cwd} projectName={projectName} busy={startingEngine !== null}
              worktree={worktree} onWorktreeChange={setWorktree} projectMenu={projectMenu}
              remote={remote} remoteLabel={remoteLabel} />
          ) : null}
          <div className="agent-chat-start-composer agent-chat-composer-shell rounded-3xl border px-4 pb-3 pt-3 transition-[border-color,box-shadow] duration-[var(--dur)] ease-[var(--ease-out)]">
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
              className="agent-chat-composer-input block max-h-72 w-full resize-none bg-transparent px-1 py-1 text-[length:var(--text-body)] leading-relaxed text-[var(--app-text-primary)] outline-none placeholder:text-[var(--app-text-tertiary)]"
            />
            <div className="agent-chat-composer-toolbar mt-2 flex items-center justify-between gap-3">
              <div className="flex shrink-0 items-center">{permissionMenu}</div>
              <div className="agent-chat-composer-options flex min-w-0 items-center justify-end gap-0.5">
                {engineMenu}
                {modelMenu}
                {modeMenu}
              </div>
              <div className="agent-chat-composer-actions flex shrink-0 items-center gap-1.5">
                {voiceButton}
                {sendButton}
              </div>
            </div>
          </div>
        </div>
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
