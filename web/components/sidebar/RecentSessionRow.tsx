// 「最近」列表的一行：点击恢复，悬浮看详情，右键菜单（恢复 / 重命名 / 置顶 / 复制 / 打开文件夹 / 移除）。
import { useState } from "react";
import { HoverCard } from "radix-ui";
import { useTranslation } from "react-i18next";
import { Copy, EyeOff, FolderOpen, MessagesSquare, Pencil, Pin, PinOff, Play, Terminal } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { toast } from "@/components/ui/toast";
import { PaletteSessionPreviewBody, type PaletteSession } from "@/components/commandPalette/PaletteSessions";
import { agentChatService } from "@/services/agentChatService";
import { providerService } from "@/services/providerService";
import { AGENT_CHAT_HISTORY_CHANGED_EVENT } from "@/stores/agentChatEvents";
import { useRecentSessionPrefsStore } from "@/stores/useRecentSessionPrefsStore";
import { handleError } from "@/utils/errorHandler";

/** 在终端里手动恢复这段会话的命令；不知道写法的 CLI 返回 null。 */
export function resumeCommandFor(session: PaletteSession): string | null {
  if (session.kind !== "cli") return null;
  const id = session.entry.sessionId;
  if (session.entry.cliTool === "claude") return `claude --resume ${id}`;
  if (session.entry.cliTool === "codex") return `codex resume ${id}`;
  return null;
}

interface RecentSessionRowProps {
  session: PaletteSession;
  pinned: boolean;
  onOpen: () => void;
}

export default function RecentSessionRow({ session, pinned, onOpen }: RecentSessionRowProps) {
  const { t } = useTranslation("sidebar");
  const [hoverOpen, setHoverOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const Icon = pinned ? Pin : session.kind === "cli" ? Terminal : MessagesSquare;
  const cwd = session.kind === "cli" ? session.entry.cwd : session.chat.cwd;
  const id = session.kind === "cli" ? session.entry.sessionId : session.chat.acpSessionId;
  const resumeCommand = resumeCommandFor(session);

  const copy = (text: string) => {
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(() => toast.success(t("copiedToClipboard")))
      .catch((error) => handleError(error, "copy recent session field"));
  };

  const commitRename = () => {
    const next = draft?.trim() ?? "";
    setDraft(null);
    if (next === session.title) return;
    if (session.kind === "chat") {
      // 对话的标题存在后端历史里；空标题不提交（后端没有「恢复自动标题」的概念）。
      if (!next) return;
      agentChatService.renameHistory(session.chat.acpSessionId, next)
        .then(() => window.dispatchEvent(new Event(AGENT_CHAT_HISTORY_CHANGED_EVENT)))
        .catch((error) => handleError(error, "rename agent chat"));
      return;
    }
    // 终端会话的标题是 CLI 自己的，这里只记一个本机的显示名；清空 = 恢复自动标题。
    useRecentSessionPrefsStore.getState().rename(session.key, next);
  };

  if (draft !== null) {
    return (
      <div className="flex w-full items-center gap-2 rounded-md bg-[var(--app-hover)] px-2 py-1">
        <Icon className="size-3.5 shrink-0 text-[var(--app-text-tertiary)]" strokeWidth={1.6} aria-hidden="true" />
        <input
          autoFocus
          aria-label={t("recentSessions.rename")}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => event.target.select()}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitRename();
            if (event.key === "Escape") setDraft(null);
          }}
          className="h-6 min-w-0 flex-1 rounded border border-[var(--app-border)] bg-[var(--app-input-bg)] px-1.5 text-[length:var(--text-row)] text-[var(--app-text-primary)] outline-none focus:border-[var(--app-accent)]"
        />
      </div>
    );
  }

  return (
    <ContextMenu onOpenChange={(open) => { setMenuOpen(open); if (open) setHoverOpen(false); }}>
      {/* 右键菜单开着时不弹详情卡片，两个浮层不叠在一起 */}
      <HoverCard.Root open={hoverOpen && !menuOpen} onOpenChange={setHoverOpen} openDelay={500} closeDelay={100}>
        <ContextMenuTrigger asChild>
          <HoverCard.Trigger asChild>
            <button
              type="button"
              data-session-kind={session.kind}
              data-pinned={pinned ? "true" : undefined}
              onClick={onOpen}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[length:var(--text-row)] text-[var(--app-text-primary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] data-[state=open]:bg-[var(--app-hover)]"
            >
              <Icon className="size-3.5 shrink-0 text-[var(--app-text-tertiary)]" strokeWidth={1.6} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{session.title}</span>
            </button>
          </HoverCard.Trigger>
        </ContextMenuTrigger>
        <HoverCard.Portal>
          <HoverCard.Content
            side="right"
            align="start"
            sideOffset={10}
            collisionPadding={12}
            data-testid="recent-session-hover-card"
            className="z-50 max-h-[min(520px,80vh)] w-[340px] overflow-y-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-3.5 shadow-[var(--sh-lg)]"
          >
            <PaletteSessionPreviewBody session={session} />
          </HoverCard.Content>
        </HoverCard.Portal>
      </HoverCard.Root>
      <ContextMenuContent className="w-52 rounded-xl p-1.5" data-testid="recent-session-menu">
        <ContextMenuItem onClick={onOpen}>
          <Play /> {t("recentSessions.resume")}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => setDraft(session.title)}>
          <Pencil /> {t("recentSessions.rename")}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => useRecentSessionPrefsStore.getState().togglePin(session.key)}>
          {pinned ? <PinOff /> : <Pin />} {pinned ? t("recentSessions.unpin") : t("recentSessions.pin")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger><Copy /> {t("recentSessions.copy")}</ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-44">
            <ContextMenuItem onClick={() => copy(session.title)}>{t("recentSessions.copyTitle")}</ContextMenuItem>
            <ContextMenuItem onClick={() => copy(id)}>{t("recentSessions.copyId")}</ContextMenuItem>
            <ContextMenuItem onClick={() => copy(cwd)}>{t("recentSessions.copyCwd")}</ContextMenuItem>
            {resumeCommand && (
              <ContextMenuItem onClick={() => copy(resumeCommand)}>{t("recentSessions.copyResumeCommand")}</ContextMenuItem>
            )}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem
          onClick={() => { void providerService.openPathInExplorer(cwd).catch((error) => handleError(error, "open session folder")); }}
        >
          <FolderOpen /> {t("openInFolder")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => useRecentSessionPrefsStore.getState().hide(session.key)}>
          <EyeOff /> {t("recentSessions.remove")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
