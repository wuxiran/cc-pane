// agent-chat 启动页：居中 hero 问候 + 建议卡 + composer 式启动栏（引擎下拉 +
// 首条 prompt 随启动发送）+ 最近会话续接。风格对标 CodexHost 的多引擎首页。
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Bug,
  ChevronDown,
  FolderOpen,
  GitBranch,
  Hammer,
  Loader2,
  SearchCode,
  Send,
  Shield,
  ShieldCheck,
  Telescope,
} from "lucide-react";
import { open as openDirDialog } from "@tauri-apps/plugin-dialog";
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import ChatVoiceButton from "./ChatVoiceButton";
import StartPrefDropdown from "./StartPrefDropdown";
import StartRecentSessions from "./StartRecentSessions";
import { samePath } from "./chatPaths";
import { takePendingResume } from "./pendingResume";
import {
  loadEnginePrefs,
  saveAutoApprove,
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
  const [startingEngine, setStartingEngine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modelPrefs, setModelPrefs] = useState<EngineModelPrefs | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const workspaces = useWorkspacesStore((state) => state.workspaces);

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
  }, [selectedEngine]);

  // 注册的工作空间→项目树（归档过滤在消费点，CLAUDE.md 约定）。
  const workspaceTree = useMemo(
    () =>
      workspaces
        .filter((workspace) => !workspace.archivedAt)
        .map((workspace) => ({
          id: workspace.id,
          name: workspace.alias || workspace.name,
          projects: workspace.projects.filter((project) => !project.archivedAt),
        }))
        .filter((workspace) => workspace.projects.length > 0),
    [workspaces],
  );

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
          loadEnginePrefs(engineId)?.autoApprove ?? false,
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

  /** 工作空间→项目下拉（含浏览目录兜底），hero 无目录态与 chip 共用。 */
  const projectMenu = (trigger: ReactNode) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
        {workspaceTree.map((workspace) => (
          <Fragment key={workspace.id}>
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-[var(--app-icon-inactive)]">
              {workspace.name}
            </DropdownMenuLabel>
            {workspace.projects.map((project) => (
              <DropdownMenuItem
                key={project.id}
                title={project.path}
                onSelect={() => onPickCwd(project.path)}
              >
                <FolderOpen className="mr-2 h-3.5 w-3.5 shrink-0 text-[var(--app-icon-inactive)]" />
                <span className="max-w-56 truncate">
                  {project.alias || projectNameOf(project.path)}
                </span>
                {cwd && samePath(project.path, cwd) ? (
                  <span className="ml-auto pl-3 text-[var(--app-accent)]">✓</span>
                ) : null}
              </DropdownMenuItem>
            ))}
          </Fragment>
        ))}
        {workspaceTree.length > 0 ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem onSelect={() => void pickCwd()}>
          <FolderOpen className="mr-2 h-3.5 w-3.5 shrink-0" />
          {t("agentChatBrowseDir")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

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
            {projectMenu(
              <button
                type="button"
                className="flex items-center gap-1.5 rounded-md border border-[var(--app-border)] px-3 py-1.5 text-sm transition-colors hover:bg-[var(--app-hover)]"
              >
                <FolderOpen className="h-4 w-4" /> {t("agentChatPickCwd")}
                <ChevronDown className="h-3.5 w-3.5 text-[var(--app-icon-inactive)]" />
              </button>,
            )}
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
              {projectMenu(
                <button
                  type="button"
                  title={cwd}
                  className="flex items-center gap-1 rounded border border-[var(--app-border)] px-1.5 py-px font-mono transition-colors hover:bg-[var(--app-hover)]"
                >
                  <FolderOpen className="h-3 w-3 shrink-0" />
                  <span className="max-w-64 truncate">{projectName}</span>
                  <ChevronDown className="h-2.5 w-2.5" />
                </button>,
              )}
              {branch ? (
                <span className="flex items-center gap-1 rounded border border-[var(--app-border)] px-1.5 py-px font-mono">
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
            rows={2}
            className="max-h-40 w-full resize-none bg-transparent text-sm outline-none placeholder:text-[var(--app-icon-inactive)]"
          />
          <div className="flex items-center justify-between gap-2 pt-1">
            <div className="flex min-w-0 items-center gap-1.5">
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
            </div>
            <div className="flex items-center gap-1.5">
            <button
              type="button"
              aria-label={t("agentChatAutoApprove")}
              title={t("agentChatAutoApproveHint")}
              className={`flex h-7 items-center gap-1 rounded-md border px-1.5 text-[11px] transition-colors ${
                modelPrefs?.autoApprove
                  ? "border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-bg)] text-[var(--app-status-warning)]"
                  : "border-[var(--app-border)] text-[var(--app-icon-inactive)] hover:bg-[var(--app-hover)]"
              }`}
              onClick={() => {
                if (!selectedEngine) return;
                saveAutoApprove(selectedEngine, !(modelPrefs?.autoApprove ?? false));
                setModelPrefs(loadEnginePrefs(selectedEngine));
              }}
            >
              {modelPrefs?.autoApprove ? (
                <ShieldCheck className="h-3.5 w-3.5" />
              ) : (
                <Shield className="h-3.5 w-3.5" />
              )}
            </button>
            <ChatVoiceButton
              chatId={chatId}
              onText={(text) =>
                setDraft((previous) => (previous ? `${previous} ${text}` : text))
              }
            />
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
        </div>

        {error ? (
          <div className="whitespace-pre-wrap break-all text-center text-xs text-[var(--app-status-danger)]">
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
