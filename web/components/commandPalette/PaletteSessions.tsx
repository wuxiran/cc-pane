// 搜索面板里的「快捷操作」和「会话」两组。
// 会话 = CLI 启动记录 + Agent 对话，按时间倒序，行尾标出类型和所在项目。
// 侧栏不再有单独的会话列表，这里是找回历史会话的入口。
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { MessagesSquare, Rocket, SquarePen, Terminal } from "lucide-react";
import { CommandGroup, CommandItem, CommandShortcut } from "@/components/ui/command";
import { agentChatService } from "@/services/agentChatService";
import { historyService, type LaunchRecord } from "@/services";
import { useDialogStore, useSshMachinesStore, useWorkspacesStore } from "@/stores";
import { AGENT_CHAT_HISTORY_CHANGED_EVENT } from "@/stores/agentChatEvents";
import { openNewAgentChat, resumeAgentChat } from "@/components/sidebar/agentChatResume";
import type { OpenTerminalOptions } from "@/types";
import type { AcpChatHistoryEntry } from "@/types/agentChat";
import { buildLaunchRecordTerminalOptions, handleErrorSilent } from "@/utils";

const MAX_RECORDS = 50;
const MAX_CHATS = 50;
/** 「全部」分类下没输入关键字时只列最近这么多条，其余靠搜索或切到「会话」分类。 */
export const RECENT_SESSION_LIMIT = 6;

export type PaletteSession =
  | { kind: "cli"; key: string; time: number; title: string; place: string; record: LaunchRecord }
  | { kind: "chat"; key: string; time: number; title: string; place: string; chat: AcpChatHistoryEntry };

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** 两种历史合成一份，按时间倒序。 */
export function mergePaletteSessions(records: LaunchRecord[], chats: AcpChatHistoryEntry[]): PaletteSession[] {
  const out: PaletteSession[] = [];
  for (const record of records) {
    if (!record.resumeSessionId) continue;
    out.push({
      kind: "cli",
      key: `r:${record.id}`,
      time: Date.parse(record.launchedAt) || 0,
      title: record.lastPrompt?.trim() || record.projectName,
      place: record.projectName,
      record,
    });
  }
  for (const chat of chats) {
    if (!chat.acpSessionId) continue;
    out.push({
      kind: "chat",
      key: `c:${chat.acpSessionId}`,
      time: chat.updatedAt,
      title: chat.title || chat.acpSessionId,
      place: baseName(chat.cwd),
      chat,
    });
  }
  return out.sort((a, b) => b.time - a.time);
}

/** 面板打开时拉取两种历史；对话标题变化时即时重拉。 */
export function usePaletteSessions(open: boolean): PaletteSession[] {
  const [records, setRecords] = useState<LaunchRecord[]>([]);
  const [chats, setChats] = useState<AcpChatHistoryEntry[]>([]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = () => {
      // 包一层 then：服务在非 Tauri 环境可能同步抛错，不能让它打断面板渲染。
      Promise.resolve().then(() => historyService.list(MAX_RECORDS))
        .then((list) => { if (!cancelled) setRecords(list ?? []); })
        .catch((error) => handleErrorSilent(error, "palette launch history"));
      Promise.resolve().then(() => agentChatService.listHistory())
        .then((list) => { if (!cancelled) setChats((list ?? []).slice(0, MAX_CHATS)); })
        .catch((error) => handleErrorSilent(error, "palette chat history"));
    };
    load();
    window.addEventListener(AGENT_CHAT_HISTORY_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(AGENT_CHAT_HISTORY_CHANGED_EVENT, load);
    };
  }, [open]);
  return useMemo(() => mergePaletteSessions(records, chats), [records, chats]);
}

/** 当前展开的工作空间 / 项目，作为「启动终端」「新建对话」的上下文。 */
function currentContext(): { workspaceName?: string; projectPath?: string } {
  const state = useWorkspacesStore.getState();
  const workspace = state.workspaces.find((item) => item.id === state.expandedWorkspaceId);
  const projectPath = workspace?.projects.find((project) => project.id === state.expandedProjectId)?.path;
  return {
    ...(workspace ? { workspaceName: workspace.name } : {}),
    ...(projectPath ? { projectPath } : {}),
  };
}

export function PaletteQuickActions({ run, newTabShortcut }: { run: (fn: () => void) => void; newTabShortcut?: string }) {
  const { t } = useTranslation(["shortcuts", "sidebar"]);
  return (
    <CommandGroup heading={t("paletteQuickActions", { ns: "shortcuts" })}>
      <CommandItem
        value={`${t("launchTerminal", { ns: "sidebar" })} launch terminal quick-launch-terminal`}
        onSelect={() => run(() => {
          const ctx = currentContext();
          useDialogStore.getState().openLauncher(Object.keys(ctx).length > 0 ? ctx : undefined);
        })}
      >
        <Rocket strokeWidth={1.5} />
        <span className="truncate">{t("launchTerminal", { ns: "sidebar" })}</span>
        {newTabShortcut && <CommandShortcut>{newTabShortcut}</CommandShortcut>}
      </CommandItem>
      <CommandItem
        value={`${t("newAgentChat", { ns: "sidebar" })} new agent chat quick-new-agent-chat`}
        onSelect={() => run(() => openNewAgentChat(currentContext().projectPath))}
      >
        <SquarePen strokeWidth={1.5} />
        <span className="truncate">{t("newAgentChat", { ns: "sidebar" })}</span>
      </CommandItem>
    </CommandGroup>
  );
}

interface PaletteSessionsGroupProps {
  sessions: PaletteSession[];
  run: (fn: () => void) => void;
  onOpenTerminal?: (opts: OpenTerminalOptions) => void;
}

export function PaletteSessionsGroup({ sessions, run, onOpenTerminal }: PaletteSessionsGroupProps) {
  const { t } = useTranslation(["shortcuts", "sidebar"]);
  if (sessions.length === 0) return null;
  return (
    <CommandGroup heading={t("paletteSessions", { ns: "shortcuts" })}>
      {sessions.map((session) => {
        const tag = session.kind === "cli"
          ? `${t("sessionTagCli", { ns: "sidebar" })}${session.record.cliTool ? ` · ${session.record.cliTool}` : ""}`
          : `${t("sessionTagChat", { ns: "sidebar" })}${session.chat.engineId ? ` · ${session.chat.engineId}` : ""}`;
        return (
          <CommandItem
            key={session.key}
            data-session-kind={session.kind}
            // value 带 key：标题相同的两条会话不会被 cmdk 当成同一项。
            value={`${session.title} ${session.place} ${tag} ${session.key}`}
            onSelect={() => run(() => {
              if (session.kind === "chat") {
                resumeAgentChat(session.chat);
                return;
              }
              onOpenTerminal?.(buildLaunchRecordTerminalOptions(
                session.record,
                useWorkspacesStore.getState().workspaces,
                useSshMachinesStore.getState().machines,
              ));
            })}
          >
            {session.kind === "cli" ? <Terminal strokeWidth={1.5} /> : <MessagesSquare strokeWidth={1.5} />}
            <span className="min-w-0 flex-1 truncate">{session.title}</span>
            <span className="shrink-0 truncate text-[length:var(--text-caption)] text-[var(--app-text-tertiary)]">
              {session.place} · {tag}
            </span>
          </CommandItem>
        );
      })}
    </CommandGroup>
  );
}
