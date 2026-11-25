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
import type { AcpChatHistoryEntry, AcpEngineInfo, AgentChatAttachment } from "@/types/agentChat";
import { agentChatService, type AcpRemoteLaunch } from "@/services/agentChatService";
import type { LocalWorktreeDraft } from "@/types/localLaunch";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { useAgentChatRemoteStore } from "@/stores/useAgentChatRemoteStore";
import { useWorkspacesStore } from "@/stores/useWorkspacesStore";
import { handleErrorSilent } from "@/utils/errorHandler";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import ChatVoiceButton from "./ChatVoiceButton";
import PermissionPolicyDropdown from "./PermissionPolicyDropdown";
import StartPrefDropdown from "./StartPrefDropdown";
import AcpRegistryDialog from "./AcpRegistryDialog";
import ChatModelPicker from "./ChatModelPicker";
import ChatLaunchProfileMenu from "./ChatLaunchProfileMenu";
import type { PickerModelRow } from "./chatModelPickerModel";
import StartProjectMenu, { workspaceLabelFor } from "./StartProjectMenu";
import StartRecentSessions from "./StartRecentSessions";
import StartTray from "./StartTray";
import { remoteLaunchOf, selectRemoteMachine } from "./remoteTarget";
import CompactStartPage from "./CompactStartPage";
import { takePendingResume } from "./pendingResume";
import { takePendingStart } from "./pendingStart";
import { usePendingDraft } from "./pendingDraft";
import { useStartPageAttachments } from "./useStartPageAttachments";
import ChatAttachmentList from "./ChatAttachmentList";
import ChatAddMenu from "./ChatAddMenu";
import { startConfiguredChat } from "./startConfiguredChat";
import "@/i18n/codexIntegrationResources";
import { CODEX_APP_SERVER_ENGINE, codexEngineLabel } from "@/lib/codexIntegration";
import {
  loadAutoApproveKinds,
  loadEnginePrefs,
  loadLaunchProfileId,
  saveAutoApproveKinds,
  saveLaunchProfileId,
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
  // 新会话的运行配置（按引擎记忆）；null = 系统默认。
  const [launchProfileId, setLaunchProfileId] = useState<string | null>(null);
  const [worktree, setWorktree] = useState<LocalWorktreeDraft | undefined>();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  usePendingDraft(chatId, setDraft, textareaRef);
  const [attachNotice, setAttachNotice] = useState<string | null>(null);
  const startAttachments = useStartPageAttachments(chatId, textareaRef, setDraft, setAttachNotice);
  const { attachments, clearAttachments } = startAttachments;
  useEffect(() => setAttachNotice(null), [attachments]);
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
    setLaunchProfileId(selectedEngine ? loadLaunchProfileId(selectedEngine) : null);
  }, [selectedEngine]);

  // 注册表装/卸后递增，触发引擎列表重拉
  const [engineReload, setEngineReload] = useState(0);
  const [registryOpen, setRegistryOpen] = useState(false);

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
  }, [preferredEngineId, engineReload]);

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
      launchAttachments?: AgentChatAttachment[],
      launchProfile?: string,
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
          firstAttachments: launchAttachments,
          launchProfileId: launchProfile,
          // 会话视图接管后附件已归首条消息（失败时在 rejectedPrompt / setup 里可重试），
          // 不能再留在同一 chatId 的会话输入区草稿里。
          onStarted: launchAttachments?.length ? clearAttachments : undefined,
        });
      } catch (startError) {
        setError(startError instanceof Error ? startError.message : String(startError));
        // 未建会话（准备失败）：附件留在启动页可直接重试；已建会话则由 setup 带着重启重发。
        if (launchAttachments?.length && useAgentChatStore.getState().chats[chatId]?.snapshot) clearAttachments();
      } finally {
        setStartingEngine(null);
      }
    },
    [chatId, onCwdAdopted, clearAttachments],
  );

  const remoteChecking = remote?.probe.status === "checking";
  const launch = useCallback(() => {
    if (!cwd || !selectedEngine || !engines?.some((engine) => engine.id === selectedEngine && engine.available) || startingEngine !== null) return;
    if (!remote) {
      // 运行配置只对声明了 launchProfileCli 的引擎下发（其余引擎后端会拒绝）。
      const profileCli = engines.find((engine) => engine.id === selectedEngine)?.launchProfileCli;
      const profile = profileCli && launchProfileId ? launchProfileId : undefined;
      void start(selectedEngine, cwd, undefined, draft, undefined, worktree, undefined, attachments, profile);
      return;
    }
    if (remoteChecking) return;
    const remoteCwd = remote.cwd.trim() || "~";
    if (remoteCwd !== remote.cwd) useAgentChatRemoteStore.getState().setRemoteCwd(chatId, remoteCwd);
    void start(selectedEngine, remoteCwd, undefined, draft, undefined, undefined, remoteLaunchOf(remote), attachments);
  }, [chatId, cwd, engines, selectedEngine, startingEngine, start, draft, worktree, remote, remoteChecking, attachments, launchProfileId]);

  const selected = engines?.find((engine) => engine.id === selectedEngine) ?? null;
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  // 常驻工作空间显示产品名（Agent Chat），普通目录退回目录名
  const remoteLabel = remote ? t("agentChatRemoteTarget", { machine: remote.machineName, path: remote.cwd.trim() || "~" }) : null;
  const projectName = remoteLabel ?? (cwd ? workspaceLabelFor(cwd, workspaces) : null);

  const launching = startingEngine !== null && startingEngine === selectedEngine;

  // 「默认」行 = 跟随引擎、不主动设置；其后是该引擎握手缓存里的模型（首次使用时为空）。
  const startModelsOf = (engineId: string): PickerModelRow[] => [
    { engineId, modelId: null, label: t("agentChatModelDefault") },
    ...((engineId === selectedEngine ? modelPrefs : loadEnginePrefs(engineId))?.models ?? []).map((model) => ({
      engineId, modelId: model.modelId, label: model.name || model.modelId, description: model.description,
    })),
  ];
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
  const engineMenu = (
            <>
              <ChatModelPicker
                engines={engines?.map((engine) => ({
                  id: engine.id, label: codexEngineLabel(engine.id, engine.label), available: engine.available, requirement: engine.requirement,
                })) ?? null}
                currentEngineId={selectedEngine}
                currentModelId={modelPrefs?.preferredModelId ?? null}
                modelsOf={startModelsOf}
                blockedReason={(engineId) => {
                  const engine = engines?.find((item) => item.id === engineId);
                  return engine?.available ? null : engine?.requirement || t("agentChatUnavailableEngine");
                }}
                effort={null}
                effortNote={t("agentChatReasoningAfterStart")}
                onPickModel={(engineId, modelId) => {
                  // 新对话还没有会话：换引擎只是改选中项，模型记成该引擎的偏好，启动后应用。
                  savePreferredModel(engineId, modelId);
                  if (engineId === selectedEngine) setModelPrefs(loadEnginePrefs(engineId));
                  else setSelectedEngine(engineId);
                }}
                footer={(modelPrefs?.modes?.length ?? 0) > 0 ? modeMenu : undefined}
                onBrowseRegistry={() => setRegistryOpen(true)}
              />
              {selectedEngine ? (
                <ChatLaunchProfileMenu
                  cli={selected?.launchProfileCli}
                  remote={Boolean(remote)}
                  value={launchProfileId}
                  disabled={startingEngine !== null}
                  onChange={(profileId) => {
                    saveLaunchProfileId(selectedEngine, profileId);
                    setLaunchProfileId(profileId);
                  }}
                />
              ) : null}
              <AcpRegistryDialog
                open={registryOpen}
                onOpenChange={setRegistryOpen}
                onInstalled={(engineId) => {
                  setSelectedEngine(engineId);
                  setEngineReload((value) => value + 1);
                }}
                onUninstalled={() => setEngineReload((value) => value + 1)}
              />
            </>
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
  const attachmentChips = attachments.length > 0 ? (
    <div className="mb-2"><ChatAttachmentList attachments={attachments} onRemove={startAttachments.removeAttachment} /></div>
  ) : null;
  const addMenu = (
    <ChatAddMenu chatId={chatId} cwd={remote ? "" : cwd} generating={false} blocked={startingEngine !== null}
      onFiles={startAttachments.attachFromDialog} onFolders={startAttachments.attachFoldersFromDialog}
      onProject={() => startAttachments.attachDirectory(cwd)} onNotice={setAttachNotice} />
  );
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
        onPaste={startAttachments.handlePaste}
        attachments={attachmentChips}
        placeholder={t("agentChatCompactPlaceholder")}
        permissionMenu={permissionMenu}
        engineMenu={engineMenu}
        modelMenu={null}
        voiceButton={voiceButton}
        sendButton={sendButton}
        notice={attachNotice ?? (selectedEngine && engines && !selected?.available ? (selected?.requirement || codexT("unavailable")) : null)}
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

        {attachNotice ? <p role="status" className="mb-2 px-2 text-sm text-[var(--app-text-tertiary)]">{attachNotice}</p> : null}
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
            {attachmentChips}
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onPaste={startAttachments.handlePaste}
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
              <div className="flex shrink-0 items-center">{addMenu}{permissionMenu}</div>
              <div className="agent-chat-composer-options flex min-w-0 items-center justify-end gap-0.5">
                {engineMenu}
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
