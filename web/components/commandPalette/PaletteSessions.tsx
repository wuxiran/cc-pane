// 搜索面板里的「快捷操作」和「会话」两组。
// 会话 = CLI 启动记录 + Agent 对话，按时间倒序，行尾标出类型和所在项目。
// 侧栏不再有单独的会话列表，这里是找回历史会话的入口。
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { MessagesSquare, Rocket, SquarePen, Terminal } from "lucide-react";
import { CommandGroup, CommandItem, CommandShortcut } from "@/components/ui/command";
import { agentChatService } from "@/services/agentChatService";
import { historyService, type LaunchRecord } from "@/services";
import { sessionIndexService } from "@/services/sessionIndexService";
import type { SessionIndexEntry } from "@/types/sessionIndex";
import { formatRelativeTime } from "@/utils";
import { useDialogStore, useSshMachinesStore, useWorkspacesStore } from "@/stores";
import { AGENT_CHAT_HISTORY_CHANGED_EVENT } from "@/stores/agentChatEvents";
import { openNewAgentChat, resumeAgentChat } from "@/components/sidebar/agentChatResume";
import type { OpenTerminalOptions } from "@/types";
import type { AcpChatHistoryEntry } from "@/types/agentChat";
import { buildLaunchRecordTerminalOptions, handleErrorSilent } from "@/utils";

const MAX_RECORDS = 50;
const MAX_CHATS = 50;
const INDEX_LIMIT = 500;
/** 「全部」分类下没输入关键字时只列最近这么多条，其余靠搜索或切到「会话」分类。 */
export const RECENT_SESSION_LIMIT = 6;

export type PaletteSession =
  | { kind: "cli"; key: string; time: number; title: string; place: string; record: LaunchRecord; index?: SessionIndexEntry }
  | { kind: "chat"; key: string; time: number; title: string; place: string; chat: AcpChatHistoryEntry };

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function firstLine(text: string | undefined): string {
  return text?.trim().split(/\r?\n/)[0]?.trim() ?? "";
}

/** 两种历史合成一份，按时间倒序。CLI 会话的标题和内容摘要来自会话索引（转录文件解析结果）。 */
export function mergePaletteSessions(
  records: LaunchRecord[],
  chats: AcpChatHistoryEntry[],
  index: ReadonlyMap<string, SessionIndexEntry> = new Map(),
): PaletteSession[] {
  const out: PaletteSession[] = [];
  for (const record of records) {
    if (!record.resumeSessionId) continue;
    const entry = index.get(record.resumeSessionId);
    out.push({
      kind: "cli",
      key: `r:${record.id}`,
      time: Date.parse(record.launchedAt) || 0,
      // 只有项目名的话一排都长一个样：优先用 CLI 自己起的标题，其次首条输入。
      title: entry?.title?.trim() || firstLine(entry?.firstPrompt) || firstLine(record.lastPrompt) || record.projectName,
      place: record.projectName,
      record,
      index: entry,
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
  const [index, setIndex] = useState<ReadonlyMap<string, SessionIndexEntry>>(new Map());
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
      Promise.resolve().then(() => sessionIndexService.list({ scope: "all", limit: INDEX_LIMIT }))
        .then((entries) => { if (!cancelled) setIndex(new Map((entries ?? []).map((entry) => [entry.sessionId, entry]))); })
        .catch((error) => handleErrorSilent(error, "palette session index"));
    };
    load();
    window.addEventListener(AGENT_CHAT_HISTORY_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(AGENT_CHAT_HISTORY_CHANGED_EVENT, load);
    };
  }, [open]);
  return useMemo(() => mergePaletteSessions(records, chats, index), [records, chats, index]);
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
            value={`${session.title} ${session.place} ${tag} ${session.kind === "cli" ? session.index?.firstPrompt.slice(0, 200) ?? "" : ""} ${session.key}`}
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

/** 当前高亮项的 value → 对应的会话（value 以会话 key 结尾）。 */
export function findSessionByValue(sessions: PaletteSession[], value: string): PaletteSession | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  return sessions.find((session) => normalized.endsWith(` ${session.key.toLowerCase()}`)) ?? null;
}

/** 高亮某条会话时右侧的内容预览：这段会话是什么、聊到哪了。 */
export function PaletteSessionPreview({ session }: { session: PaletteSession }) {
  const { t } = useTranslation(["shortcuts", "sidebar"]);
  const index = session.kind === "cli" ? session.index : undefined;
  const path = session.kind === "cli" ? session.record.launchCwd || session.record.projectPath : session.chat.cwd;
  const tool = session.kind === "cli" ? session.record.cliTool : session.chat.engineId;
  const firstPrompt = index?.firstPrompt.trim() || (session.kind === "cli" ? session.record.lastPrompt?.trim() : "") || "";
  const summary = index?.lastSummary.trim() ?? "";
  const meta = [
    `${t(session.kind === "cli" ? "sessionTagCli" : "sessionTagChat", { ns: "sidebar" })}${tool ? ` · ${tool}` : ""}`,
    session.time > 0 ? formatRelativeTime(new Date(session.time).toISOString()) : "",
    index && index.messageCount > 0 ? t("palettePreviewMessages", { ns: "shortcuts", count: index.messageCount }) : "",
  ].filter(Boolean).join(" · ");
  return (
    <aside
      data-testid="palette-session-preview"
      className="hidden w-[260px] shrink-0 flex-col gap-2 overflow-y-auto border-l border-[var(--app-border)] p-3 sm:flex"
    >
      <div className="text-[length:var(--text-row)] font-medium leading-snug text-[var(--app-text-primary)] line-clamp-3">{session.title}</div>
      <div className="text-[length:var(--text-micro)] text-[var(--app-text-tertiary)]">{meta}</div>
      <div className="break-all font-mono text-[length:var(--text-nano)] text-[var(--app-text-tertiary)]">{path}</div>
      {firstPrompt && (
        <section>
          <div className="mb-0.5 text-[length:var(--text-micro)] text-[var(--app-text-tertiary)]">{t("palettePreviewFirstPrompt", { ns: "shortcuts" })}</div>
          <p className="whitespace-pre-wrap break-words text-[length:var(--text-caption)] leading-relaxed text-[var(--app-text-secondary)] line-clamp-6">{firstPrompt}</p>
        </section>
      )}
      {summary && (
        <section>
          <div className="mb-0.5 text-[length:var(--text-micro)] text-[var(--app-text-tertiary)]">{t("palettePreviewSummary", { ns: "shortcuts" })}</div>
          <p className="whitespace-pre-wrap break-words text-[length:var(--text-caption)] leading-relaxed text-[var(--app-text-secondary)] line-clamp-[8]">{summary}</p>
        </section>
      )}
      {!firstPrompt && !summary && (
        <p className="text-[length:var(--text-caption)] text-[var(--app-text-tertiary)]">{t("palettePreviewNoContent", { ns: "shortcuts" })}</p>
      )}
    </aside>
  );
}
