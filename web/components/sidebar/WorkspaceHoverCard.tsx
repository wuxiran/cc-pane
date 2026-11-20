// 工作空间行的悬停卡片：名字、项目数、各项目文件夹的完整路径、「编辑工作空间」入口。
// 编辑对话框也挂在这里，WorkspaceItem 只需要把行包进来。
import { useState, type ReactNode } from "react";
import { HoverCard } from "radix-ui";
import { useTranslation } from "react-i18next";
import { Folder, Layers, Settings } from "lucide-react";
import type { Workspace } from "@/types";
import WorkspaceEditDialog from "./WorkspaceEditDialog";
import { workspaceFolders } from "./workspaceFolders";

interface WorkspaceHoverCardProps {
  workspace: Workspace;
  /** 系统工作空间、拖拽中：不出卡片 */
  disabled?: boolean;
  /** 行本身（必须是单个可接收 ref 的元素） */
  children: ReactNode;
}

export default function WorkspaceHoverCard({ workspace, disabled = false, children }: WorkspaceHoverCardProps) {
  const { t } = useTranslation("sidebar");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  if (disabled) return <>{children}</>;
  const folders = workspaceFolders(workspace);

  return (
    <>
      <HoverCard.Root open={open && !editing} onOpenChange={setOpen} openDelay={550} closeDelay={120}>
        <HoverCard.Trigger asChild>{children}</HoverCard.Trigger>
        <HoverCard.Portal>
          <HoverCard.Content
            side="right"
            align="start"
            sideOffset={8}
            collisionPadding={12}
            data-testid="workspace-hover-card"
            className="z-50 w-[320px] rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-1.5 text-[length:var(--text-row)] text-[var(--app-text-primary)] shadow-lg motion-safe:animate-in motion-safe:fade-in"
          >
            <div className="flex items-center gap-2 px-2.5 py-1.5">
              <Folder className="size-4 shrink-0 text-[var(--app-text-secondary)]" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate font-medium">{workspace.alias || workspace.name}</span>
            </div>
            <div className="flex items-center gap-2 px-2.5 py-1.5 text-[var(--app-text-secondary)]">
              <Layers className="size-4 shrink-0 text-[var(--app-text-tertiary)]" aria-hidden="true" />
              {t("workspaceCard.projectCount", { count: folders.length })}
            </div>
            <div className="my-1 border-t border-[var(--app-border)]" />
            {folders.length === 0 ? (
              <p className="px-2.5 py-1.5 text-[var(--app-text-tertiary)]">{t("workspaceCard.noFolders")}</p>
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
              onClick={() => { setOpen(false); setEditing(true); }}
            >
              <Settings className="size-4 shrink-0 text-[var(--app-text-tertiary)]" aria-hidden="true" />
              {t("workspaceEdit.title")}
            </button>
          </HoverCard.Content>
        </HoverCard.Portal>
      </HoverCard.Root>
      {editing && <WorkspaceEditDialog workspace={workspace} onOpenChange={(next) => { if (!next) setEditing(false); }} />}
    </>
  );
}
