// 简洁模式里的一行工作空间：文件夹图标 + 名字，点一下展开/收起它下面的会话。
// 悬停时右侧露出「更多」和「编辑」，并弹出一张卡片：会话数、项目文件夹、编辑入口。
import { HoverCard } from "radix-ui";
import { useTranslation } from "react-i18next";
import {
  Check, Folder, FolderOpen, MessageCircle, MessagesSquare, MoreHorizontal, Settings, SquarePen, TerminalSquare,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Workspace } from "@/types";
import { workspaceFolders } from "./simpleExplorerModel";

interface SimpleWorkspaceRowProps {
  /** null = 「其他」：没落到任何工作空间的会话，没有可编辑的东西 */
  workspace: Workspace | null;
  label: string;
  sessionCount: number;
  collapsed: boolean;
  isDefaultContext: boolean;
  hideTerminalActions: boolean;
  onToggle: () => void;
  onNewChat: (workspace: Workspace) => void;
  onLaunch: (workspace: Workspace) => void;
  onSetDefault: (workspace: Workspace) => void;
  onEdit: (workspace: Workspace) => void;
}

const ICON_BUTTON_CLASS =
  "flex size-6 items-center justify-center rounded text-[var(--app-text-tertiary)] transition-colors hover:bg-[var(--app-active-bg)] hover:text-[var(--app-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]";

export default function SimpleWorkspaceRow({
  workspace, label, sessionCount, collapsed, isDefaultContext, hideTerminalActions,
  onToggle, onNewChat, onLaunch, onSetDefault, onEdit,
}: SimpleWorkspaceRowProps) {
  const { t } = useTranslation("sidebar");
  const FolderIcon = collapsed ? Folder : FolderOpen;

  const row = (
    <div
      data-testid="simple-workspace-row"
      data-workspace-name={workspace?.name}
      className="group relative flex items-center rounded-md transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] focus-within:bg-[var(--app-hover)]"
    >
      <button
        type="button"
        data-typeahead-label={label}
        aria-expanded={!collapsed}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
        onClick={onToggle}
      >
        <FolderIcon className="size-4 shrink-0 text-[var(--app-text-secondary)]" strokeWidth={1.6} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-row)] text-[var(--app-text-primary)]">{label}</span>
      </button>
      {workspace && (
        <div className="mr-1 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 has-[[data-state=open]]:opacity-100">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label={t("simple.workspaceMore")} className={ICON_BUTTON_CLASS}>
                <MoreHorizontal className="size-4" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-52">
              <DropdownMenuItem onSelect={() => onNewChat(workspace)}>
                <MessagesSquare /> {t("simple.newChatHere")}
              </DropdownMenuItem>
              {!hideTerminalActions && (
                <DropdownMenuItem onSelect={() => onLaunch(workspace)}>
                  <TerminalSquare /> {t("simple.launchHere")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem disabled={isDefaultContext} onSelect={() => onSetDefault(workspace)}>
                <Check /> {t(isDefaultContext ? "simple.defaultContext" : "simple.setDefaultContext")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onEdit(workspace)}>
                <Settings /> {t("simple.editWorkspace")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <button type="button" aria-label={t("simple.newChatHere")} className={ICON_BUTTON_CLASS} onClick={() => onNewChat(workspace)}>
            <SquarePen className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );

  if (!workspace) return row;
  const folders = workspaceFolders(workspace);

  return (
    <HoverCard.Root openDelay={450} closeDelay={120}>
      <HoverCard.Trigger asChild>{row}</HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side="right"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          data-testid="simple-workspace-card"
          className="z-50 w-[320px] rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-1.5 text-[length:var(--text-row)] text-[var(--app-text-primary)] shadow-lg motion-safe:animate-in motion-safe:fade-in"
        >
          <div className="flex items-center gap-2 px-2.5 py-1.5">
            <Folder className="size-4 shrink-0 text-[var(--app-text-secondary)]" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
            {isDefaultContext && <Check className="size-3.5 shrink-0 text-[var(--app-text-tertiary)]" aria-label={t("simple.defaultContext")} />}
          </div>
          <div className="flex items-center gap-2 px-2.5 py-1.5 text-[var(--app-text-secondary)]">
            <MessageCircle className="size-4 shrink-0 text-[var(--app-text-tertiary)]" aria-hidden="true" />
            {t("simple.chatCount", { count: sessionCount })}
          </div>
          <div className="my-1 border-t border-[var(--app-border)]" />
          {folders.length === 0 ? (
            <p className="px-2.5 py-1.5 text-[var(--app-text-tertiary)]">{t("simple.noFolders")}</p>
          ) : (
            folders.map((folder) => (
              <div key={folder.id} className="flex items-start gap-2 px-2.5 py-1.5 text-[var(--app-text-secondary)]">
                <Folder className="mt-0.5 size-4 shrink-0 text-[var(--app-text-tertiary)]" aria-hidden="true" />
                <span className="min-w-0 flex-1 break-all leading-snug">{folder.path}</span>
              </div>
            ))
          )}
          <div className="my-1 border-t border-[var(--app-border)]" />
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--app-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
            onClick={() => onEdit(workspace)}
          >
            <Settings className="size-4 shrink-0 text-[var(--app-text-tertiary)]" aria-hidden="true" />
            {t("simple.editWorkspace")}
          </button>
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}
