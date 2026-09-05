// 首页「对 agent 说」：一句话交给编排管家，回车即在工作区开一个 agent-chat
// 标签、带管家指令发出首条消息并切到工作区。首页只是发起器，对话在工作区进行。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUp, Bot, ChevronDown, FolderOpen, Loader2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import StartProjectMenu, { projectNameOf } from "@/components/agentchat/StartProjectMenu";
import { setPendingStart } from "@/components/agentchat/pendingStart";
import { CONCIERGE_SYSTEM_PROMPT } from "@/components/onboarding/AgentConciergeEntry";
import { agentChatService } from "@/services/agentChatService";
import { usePanesStore, useWorkspacesStore } from "@/stores";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import type { AcpEngineInfo } from "@/types/agentChat";
import { handleErrorSilent } from "@/utils/errorHandler";

const ENGINE_PREF_KEY = "ccpanes.home.agentEngine";

function loadPreferredEngine(): string | null {
  try {
    return localStorage.getItem(ENGINE_PREF_KEY);
  } catch {
    return null;
  }
}

function savePreferredEngine(engineId: string): void {
  try {
    localStorage.setItem(ENGINE_PREF_KEY, engineId);
  } catch {
    // 无持久化也不影响本次发送
  }
}

export default function HomeAgentPrompt() {
  const { t } = useTranslation("home");
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const expandedWorkspaceId = useWorkspacesStore((state) => state.expandedWorkspaceId);
  const expandedProjectId = useWorkspacesStore((state) => state.expandedProjectId);
  const [engines, setEngines] = useState<AcpEngineInfo[] | null>(null);
  const [engineId, setEngineId] = useState<string | null>(null);
  const [cwdOverride, setCwdOverride] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // 默认目标：侧栏当前展开的项目 → 其所在工作空间的首个项目 → 任一项目 → 工作空间根目录。
  const defaultCwd = useMemo(() => {
    const active = workspaces.filter((workspace) => !workspace.archivedAt);
    const expanded = active.find((workspace) => workspace.id === expandedWorkspaceId);
    const expandedProject = expanded?.projects.find(
      (project) => project.id === expandedProjectId && !project.archivedAt,
    );
    if (expandedProject) return expandedProject.path;
    const ordered = expanded ? [expanded, ...active.filter((w) => w !== expanded)] : active;
    for (const workspace of ordered) {
      const project = workspace.projects.find((item) => !item.archivedAt);
      if (project) return project.path;
    }
    for (const workspace of ordered) {
      if (!workspace.isDefault && workspace.path) return workspace.path;
    }
    return "";
  }, [workspaces, expandedWorkspaceId, expandedProjectId]);
  const cwd = cwdOverride ?? defaultCwd;

  useEffect(() => {
    let cancelled = false;
    agentChatService
      .listEngines()
      .then((list) => {
        if (cancelled) return;
        setEngines(list);
        const preferred = loadPreferredEngine();
        const fallback = list.find((engine) => engine.available) ?? list[0];
        const chosen = list.find((engine) => engine.id === preferred && engine.available) ?? fallback;
        setEngineId(chosen?.id ?? null);
      })
      .catch((error) => {
        // Web 端 / 未就绪：没有引擎就只展示禁用态，不报错打扰。
        handleErrorSilent(error, "list acp engines for home prompt");
        if (!cancelled) setEngines([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedEngine = engines?.find((engine) => engine.id === engineId) ?? null;
  const text = draft.trim();
  const canSend = Boolean(cwd && selectedEngine?.available && text) && !sending;

  const submit = useCallback(() => {
    if (!canSend || !engineId) return;
    setSending(true);
    const tabId = usePanesStore.getState().openAgentChat(cwd);
    if (!tabId) {
      setSending(false);
      return;
    }
    setPendingStart(tabId, {
      engineId,
      cwd,
      firstPrompt: text,
      preamble: CONCIERGE_SYSTEM_PROMPT,
    });
    setDraft("");
    setSending(false);
    useActivityBarStore.getState().setAppViewMode("panes");
  }, [canSend, cwd, engineId, text]);

  const placeholder = cwd ? t("agentPrompt.placeholder") : t("agentPrompt.placeholderNoTarget");

  return (
    <div
      data-testid="home-agent-prompt"
      className="rounded-xl border border-[var(--app-home-border)] bg-[var(--app-home-surface)] px-3 pb-2 pt-2.5 transition-[border-color,box-shadow] duration-[var(--dur)] ease-[var(--ease-out)] focus-within:border-[var(--app-accent)]/70 focus-within:shadow-[0_0_0_3px_var(--app-active-bg)]"
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--app-text-tertiary)]">
        <span className="inline-flex items-center gap-1 font-medium text-[var(--app-text-secondary)]">
          <Bot className="h-3.5 w-3.5 text-[var(--app-accent)]" aria-hidden="true" />
          {t("agentPrompt.title")}
        </span>
        <StartProjectMenu
          cwd={cwd}
          onPickCwd={setCwdOverride}
          trigger={
            <button
              type="button"
              title={cwd || undefined}
              className="flex items-center gap-1 rounded-md border border-[var(--app-border)] bg-[var(--app-overlay)] px-1.5 py-0.5 font-mono text-[var(--app-text-secondary)] transition-colors hover:text-[var(--app-text-primary)]"
            >
              <FolderOpen className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="max-w-64 truncate">
                {cwd ? projectNameOf(cwd) : t("agentPrompt.pickTarget")}
              </span>
              <ChevronDown className="h-2.5 w-2.5" aria-hidden="true" />
            </button>
          }
        />
      </div>
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={placeholder}
        aria-label={t("agentPrompt.title")}
        rows={2}
        className="max-h-40 w-full resize-none bg-transparent text-sm leading-relaxed text-[var(--app-text-primary)] outline-none placeholder:text-[var(--app-text-tertiary)]"
      />
      <div className="mt-1 flex items-center justify-between gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={engines === null || engines.length === 0}
              className="flex h-7 items-center gap-1.5 rounded-md border border-[var(--app-border)] bg-[var(--app-overlay)] px-2 text-xs font-medium text-[var(--app-text-primary)] shadow-sm transition-colors hover:border-[var(--app-accent)]/50 disabled:opacity-50"
            >
              {engines === null ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : engines.length === 0 ? (
                <span className="text-[var(--app-text-tertiary)]">{t("agentPrompt.noEngine")}</span>
              ) : (
                <>
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      selectedEngine?.available
                        ? "bg-[var(--app-status-success)]"
                        : "bg-[var(--app-text-tertiary)]"
                    }`}
                  />
                  {selectedEngine?.label ?? t("agentPrompt.pickEngine")}
                  <ChevronDown className="h-3 w-3 text-[var(--app-text-tertiary)]" aria-hidden="true" />
                </>
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {(engines ?? []).map((engine) => (
              <DropdownMenuItem
                key={engine.id}
                disabled={!engine.available}
                title={engine.available ? undefined : engine.requirement}
                onSelect={() => {
                  setEngineId(engine.id);
                  savePreferredEngine(engine.id);
                }}
              >
                <span
                  className={`mr-2 h-1.5 w-1.5 rounded-full ${
                    engine.available ? "bg-[var(--app-status-success)]" : "bg-[var(--app-text-tertiary)]"
                  }`}
                />
                {engine.label}
                {engine.id === engineId ? (
                  <span className="ml-auto pl-3 text-[var(--app-accent)]">✓</span>
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <IconTooltipButton
          label={t("agentPrompt.send")}
          kbd="Enter"
          disabled={!canSend}
          data-testid="home-agent-prompt-send"
          className="h-7 w-7 rounded-full bg-[var(--app-accent)] text-white hover:bg-[var(--app-accent)] hover:text-white hover:opacity-90 disabled:opacity-35"
          onClick={submit}
        >
          <ArrowUp className="h-4 w-4" strokeWidth={2.5} aria-hidden="true" />
        </IconTooltipButton>
      </div>
    </div>
  );
}
