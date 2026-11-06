// 右侧面板「对话」视图：顶部一排对话标签（新建 / 历史 / 更多），下面是对话本体。
//
// 对话本体直接复用窗格里的 AgentChatTabContent：会话按 chatId 寻址，这里递一个
// 不进 usePanesStore 的「虚拟标签」即可。移到窗格时用同一个 chatId 开 agent-chat
// 标签，会话不断。
import { useEffect, useMemo } from "react";
import { History, MoreHorizontal, PanelRightOpen, Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import AgentChatTabContent from "@/components/agentchat/AgentChatTabContent";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { useAgentChatStore, type AgentChatSessionState } from "@/stores/useAgentChatStore";
import { useDockChatStore, type DockChatEntry } from "@/stores/useDockChatStore";
import { usePanesStore } from "@/stores/usePanesStore";
import type { OpenTerminalOptions, Tab, Workspace, WorkspaceProject } from "@/types";
import DockChatHistory from "./DockChatHistory";

export type DockChatStatus = "running" | "attention" | "idle";

export function dockChatStatus(chat: AgentChatSessionState | undefined): DockChatStatus {
  if (!chat) return "idle";
  if (chat.pendingPermissions.length > 0) return "attention";
  if (chat.snapshot?.phase === "generating" || chat.pendingPrompt || chat.setup?.pending) return "running";
  return "idle";
}

/** 标签标题：显式标题 > 第一条用户消息 > 「新对话」。 */
export function dockChatTitle(entry: DockChatEntry, chat: AgentChatSessionState | undefined, fallback: string): string {
  if (entry.title) return entry.title;
  const first = chat?.items.find((item) => item.type === "user");
  const text = first && first.type === "user" ? first.text.trim().replace(/\s+/g, " ") : "";
  return text ? text.slice(0, 40) : fallback;
}

export function dockChatVirtualTab(entry: DockChatEntry): Tab {
  return {
    id: entry.id,
    title: entry.title,
    contentType: "agent-chat",
    projectId: "",
    projectPath: entry.cwd ?? "",
    sessionId: null,
    agentEngineId: entry.engineId,
  };
}

const STATUS_COLOR: Record<DockChatStatus, string | null> = {
  running: "var(--app-status-warning)",
  attention: "var(--app-status-danger)",
  idle: null,
};

interface DockChatViewProps {
  /** 新对话的默认项目（跟随当前终端 / 选中项目）。 */
  defaultCwd: string | null;
  workspaces: Workspace[];
  workspace: Workspace | null;
  project: WorkspaceProject | null;
  onOpenTerminal: (options: OpenTerminalOptions) => void;
}

export default function DockChatView({ defaultCwd, workspaces, workspace, project, onOpenTerminal }: DockChatViewProps) {
  const { t } = useTranslation("sidebar");
  const chats = useDockChatStore((state) => state.chats);
  const activeId = useDockChatStore((state) => state.activeId);
  const historyOpen = useDockChatStore((state) => state.historyOpen);
  const sessions = useAgentChatStore((state) => state.chats);
  const active = chats.find((chat) => chat.id === activeId) ?? null;

  // 面板里一个对话都没有时直接给一个新对话（引擎选择页），不留空白。
  useEffect(() => {
    const state = useDockChatStore.getState();
    if (state.chats.length === 0) state.newChat(defaultCwd);
    else if (!state.chats.some((chat) => chat.id === state.activeId)) state.select(state.chats[0].id);
  }, [chats.length, defaultCwd]);

  // 开聊后把引擎和 ACP 会话号记下来，重启后才能续接；标题取第一条用户消息。
  useEffect(() => {
    const store = useDockChatStore.getState();
    for (const entry of chats) {
      const session = sessions[entry.id];
      const snapshot = session?.snapshot;
      if (!snapshot) continue;
      store.syncSession(entry.id, {
        engineId: snapshot.engineId,
        acpSessionId: snapshot.acpSessionId,
        title: entry.title ? undefined : dockChatTitle(entry, session, "") || undefined,
      });
    }
  }, [chats, sessions]);

  const virtualTab = useMemo(() => (active ? dockChatVirtualTab(active) : null), [active]);

  const moveToPane = (entry: DockChatEntry) => {
    const cwd = useAgentChatStore.getState().chats[entry.id]?.cwdOverride || entry.cwd || undefined;
    const opened = usePanesStore.getState().openAgentChat(cwd, { tabId: entry.id, engineId: entry.engineId });
    if (!opened) return;
    useDockChatStore.getState().detach(entry.id);
    useActivityBarStore.getState().setAppViewMode("panes");
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="dock-chat-view">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--app-border)] pl-2 pr-1">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden" role="tablist" aria-label={t("rightDock.chatTabs")}>
          {chats.map((entry) => {
            const selected = entry.id === activeId && !historyOpen;
            const status = dockChatStatus(sessions[entry.id]);
            const color = STATUS_COLOR[status];
            const title = dockChatTitle(entry, sessions[entry.id], t("rightDock.newChat"));
            return (
              <div
                key={entry.id}
                className={`group flex h-[26px] min-w-0 max-w-[160px] shrink items-center rounded-[5px] ${
                  selected ? "bg-[var(--app-active-bg)] text-[var(--app-text-primary)]" : "text-[var(--app-text-tertiary)] hover:text-[var(--app-text-primary)]"
                }`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  data-testid="dock-chat-tab"
                  title={title}
                  className="flex h-full min-w-0 items-center gap-1.5 pl-2 pr-1 text-xs"
                  onClick={() => useDockChatStore.getState().select(entry.id)}
                >
                  {color && (
                    <span
                      aria-label={t(status === "running" ? "rightDock.chatRunning" : "rightDock.chatNeedsYou")}
                      role="img"
                      className="size-[7px] shrink-0 rounded-full"
                      style={{ background: color }}
                    />
                  )}
                  <span className="truncate">{title}</span>
                </button>
                <button
                  type="button"
                  aria-label={t("rightDock.closeChat")}
                  className="mr-1 flex size-4 shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-[var(--app-hover)] focus-visible:opacity-100 group-hover:opacity-100"
                  onClick={() => useDockChatStore.getState().close(entry.id)}
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
        </div>
        <IconButton label={t("rightDock.newChat")} onClick={() => useDockChatStore.getState().newChat(defaultCwd)}>
          <Plus className="size-4" />
        </IconButton>
        <IconButton
          label={t("rightDock.chatHistory")}
          pressed={historyOpen}
          onClick={() => {
            const store = useDockChatStore.getState();
            if (store.historyOpen) store.closeHistory();
            else store.openHistory();
          }}
        >
          <History className="size-4" />
        </IconButton>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t("rightDock.chatMore")}
                  disabled={!active}
                  className="flex size-7 items-center justify-center rounded-md text-[var(--app-text-tertiary)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)] disabled:opacity-40"
                >
                  <MoreHorizontal className="size-4" />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("rightDock.chatMore")}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={!active} onSelect={() => active && moveToPane(active)}>
              <PanelRightOpen className="size-3.5" />
              {t("rightDock.moveChatToPane")}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!active} onSelect={() => active && useDockChatStore.getState().close(active.id)}>
              <X className="size-3.5" />
              {t("rightDock.closeChat")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {historyOpen ? (
          <DockChatHistory workspaces={workspaces} workspace={workspace} project={project} onOpenTerminal={onOpenTerminal} />
        ) : virtualTab ? (
          <AgentChatTabContent key={virtualTab.id} tab={virtualTab} compact />
        ) : null}
      </div>
    </div>
  );
}

function IconButton({ label, pressed, onClick, children }: { label: string; pressed?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={pressed}
          onClick={onClick}
          className={`flex size-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)] ${
            pressed ? "bg-[var(--app-active-bg)] text-[var(--app-text-primary)]" : "text-[var(--app-text-tertiary)]"
          }`}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
