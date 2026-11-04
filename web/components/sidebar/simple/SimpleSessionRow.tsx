// 简洁模式的一行会话：类型小图标 + 标题 + 相对时间；右键置顶/删除。
import { MessagesSquare, Pin, PinOff, TerminalSquare, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { formatRelativeTime } from "@/utils";
import type { SimpleSession } from "./simpleExplorerModel";

interface SimpleSessionRowProps {
  session: SimpleSession;
  pinned: boolean;
  /** 挂在项目下时缩进一级 */
  nested?: boolean;
  onOpen: (session: SimpleSession) => void;
  onTogglePin: (session: SimpleSession) => void;
  onDelete: (session: SimpleSession) => void;
}

function relativeTime(time: number): string {
  if (!time) return "";
  try {
    return formatRelativeTime(new Date(time).toISOString());
  } catch {
    return "";
  }
}

export default function SimpleSessionRow({ session, pinned, nested = false, onOpen, onTogglePin, onDelete }: SimpleSessionRowProps) {
  const { t } = useTranslation("sidebar");
  const Icon = session.kind === "terminal" ? TerminalSquare : MessagesSquare;
  const subtitle = session.kind === "terminal"
    ? session.record.cliTool && session.record.cliTool !== "none" ? session.record.cliTool : null
    : session.entry.engineId;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          data-testid="simple-session-row"
          data-session-key={session.key}
          data-typeahead-label={session.title}
          title={session.title}
          className={`group flex w-full items-center gap-2 rounded-md py-1 pr-2 text-left transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] ${nested ? "pl-7" : "pl-2"}`}
          onClick={() => onOpen(session)}
        >
          <Icon className="size-3 shrink-0 text-[var(--app-text-tertiary)]" strokeWidth={1.8} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-[length:var(--text-row)] text-[var(--app-text-primary)]">{session.title}</span>
          {subtitle && (
            <span className="shrink-0 text-[length:var(--text-micro)] text-[var(--app-text-tertiary)]">{subtitle}</span>
          )}
          <span className="shrink-0 text-[length:var(--text-micro)] tabular-nums text-[var(--app-text-tertiary)]">{relativeTime(session.time)}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem onClick={() => onTogglePin(session)}>
          {pinned ? <PinOff /> : <Pin />} {t(pinned ? "simple.unpin" : "simple.pin")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={() => onDelete(session)}>
          <Trash2 /> {t("simple.deleteSession")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
