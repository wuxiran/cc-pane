import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, FolderOpen, Pencil, Pin, Star, Terminal, Trash2 } from "lucide-react";
import type { Workspace } from "@/types";
import { getWorkspaceOpenPath } from "./mobileUtils";
import type { MobileWorkspaceActions } from "./types";

interface MobileWorkspaceActionSheetProps extends MobileWorkspaceActions {
  workspace: Workspace;
  onClose: () => void;
  onOpenWorkspace: () => void;
}

/** 移动端底部动作面板：侧栏右键菜单的触屏等价物，动作与桌面端一一对应。 */
export default function MobileWorkspaceActionSheet({
  workspace,
  onClose,
  onOpenWorkspace,
  onToggleWorkspacePinned: onTogglePinned,
  onToggleWorkspaceHidden: onToggleHidden,
  onOpenWorkspaceFolder: onOpenFolder,
  onOpenWorkspaceFileBrowser: onOpenFileBrowser,
  onSetWorkspaceAlias: onSetAlias,
  onRenameWorkspace: onRename,
  onDeleteWorkspace: onDelete,
}: MobileWorkspaceActionSheetProps) {
  const { t } = useTranslation("mobile");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const workspacePath = getWorkspaceOpenPath(workspace);
  const hasProject = workspace.projects.length > 0;

  const runAction = async (actionId: string, action: () => void | Promise<void>, closeAfter = false) => {
    setBusyAction(actionId);
    setError(null);
    try {
      await action();
      if (closeAfter) onClose();
    } catch (caught) {
      console.error(`Mobile workspace action failed: ${actionId}`, caught);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyAction(null);
    }
  };

  const promptForValue = (
    title: string,
    currentValue: string,
    onSubmit: (value: string | null) => Promise<void>,
  ) => {
    const next = window.prompt(title, currentValue);
    if (next === null) return;
    void runAction(title, () => onSubmit(next.trim() || null), true);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <button
        type="button"
        aria-label={t("sheet.closeBackdrop")}
        className="absolute inset-0 bg-[var(--app-overlay)]"
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t("sheet.title")}
        className="relative z-10 max-h-[82dvh] w-full max-w-[430px] overflow-y-auto rounded-t-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4 shadow-2xl"
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-[var(--app-border)]" />
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[12px] font-medium text-[var(--app-text-tertiary)]">{t("sheet.title")}</div>
            <h2 className="mt-1 truncate text-[18px] font-semibold text-[var(--app-text-primary)]">{workspace.alias ?? workspace.name}</h2>
            <p className="mt-1 truncate text-[12px] text-[var(--app-text-tertiary)]">{workspace.path ?? workspace.name}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-9 w-9 flex-none place-items-center rounded-md border border-[var(--app-border)] text-[var(--app-text-secondary)]"
            aria-label={t("sheet.close")}
          >
            <ChevronRight className="h-4 w-4 rotate-90" />
          </button>
        </div>

        <ActionGroup title={t("sheet.groups.common")}>
          <ActionRow
            icon={<Star className="h-4 w-4" />}
            label={workspace.pinned ? t("sheet.unpin") : t("sheet.pin")}
            detail={workspace.pinned ? t("sheet.unpinDetail") : t("sheet.pinDetail")}
            busy={busyAction === "toggle-pinned"}
            onClick={onTogglePinned ? () => void runAction("toggle-pinned", () => onTogglePinned(workspace), true) : undefined}
          />
          <ActionRow
            icon={<Terminal className="h-4 w-4" />}
            label={t("sheet.openTerminal")}
            detail={hasProject ? t("sheet.openTerminalDetail") : t("sheet.openTerminalDisabled")}
            disabled={!hasProject}
            onClick={hasProject ? () => {
              onOpenWorkspace();
              onClose();
            } : undefined}
          />
        </ActionGroup>

        <ActionGroup title={t("sheet.groups.workspace")}>
          <ActionRow
            icon={<FolderOpen className="h-4 w-4" />}
            label={t("sheet.openFolder")}
            detail={workspacePath ? t("sheet.openFolderDetail") : t("sheet.noOpenablePath")}
            disabled={!workspacePath}
            busy={busyAction === "open-folder"}
            onClick={workspacePath && onOpenFolder ? () => void runAction("open-folder", () => onOpenFolder(workspace), true) : undefined}
          />
          <ActionRow
            icon={<FolderOpen className="h-4 w-4" />}
            label={t("sheet.openInFileBrowser")}
            detail={workspacePath ? t("sheet.openInFileBrowserDetail") : t("sheet.noOpenablePath")}
            disabled={!workspacePath}
            onClick={workspacePath && onOpenFileBrowser ? () => {
              onOpenFileBrowser(workspace);
              onClose();
            } : undefined}
          />
        </ActionGroup>

        <ActionGroup title={t("sheet.groups.settings")}>
          <ActionRow
            icon={<Pin className="h-4 w-4" />}
            label={workspace.hidden ? t("sheet.showWorkspace") : t("sheet.hideWorkspace")}
            detail={workspace.hidden ? t("sheet.showDetail") : t("sheet.hideDetail")}
            busy={busyAction === "toggle-hidden"}
            onClick={onToggleHidden ? () => void runAction("toggle-hidden", () => onToggleHidden(workspace), true) : undefined}
          />
          <ActionRow
            icon={<Pencil className="h-4 w-4" />}
            label={t("sheet.setAlias")}
            detail={t("sheet.setAliasDetail")}
            busy={busyAction === t("sheet.setAlias")}
            onClick={onSetAlias ? () => promptForValue(t("sheet.setAlias"), workspace.alias ?? "", (alias) => onSetAlias(workspace, alias)) : undefined}
          />
          <ActionRow
            icon={<Pencil className="h-4 w-4" />}
            label={t("sheet.rename")}
            detail={t("sheet.renameDetail")}
            busy={busyAction === t("sheet.rename")}
            onClick={onRename ? () => promptForValue(t("sheet.rename"), workspace.name, async (name) => {
              if (!name) return;
              await onRename(workspace, name);
            }) : undefined}
          />
        </ActionGroup>

        <ActionGroup title={t("sheet.groups.danger")}>
          <ActionRow
            icon={<Trash2 className="h-4 w-4" />}
            label={t("sheet.deleteWorkspace")}
            detail={t("sheet.deleteDetail")}
            destructive
            busy={busyAction === "delete-workspace"}
            onClick={onDelete ? () => {
              if (!window.confirm(t("sheet.deleteConfirm", { name: workspace.alias ?? workspace.name }))) return;
              void runAction("delete-workspace", () => onDelete(workspace), true);
            } : undefined}
          />
        </ActionGroup>

        {error && (
          <div className="mt-3 rounded-md border border-[color-mix(in_srgb,var(--app-status-danger)_30%,transparent)] bg-[var(--app-status-danger-bg)] px-3 py-2 text-[12px] text-[var(--app-status-danger)]">
            {error}
          </div>
        )}
      </section>
    </div>
  );
}

function ActionGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="mt-4">
      <div className="mb-2">
        <h3 className="text-[13px] font-semibold text-[var(--app-text-primary)]">{title}</h3>
      </div>
      <div className="overflow-hidden rounded-md border border-[var(--app-border)]">
        {children}
      </div>
    </div>
  );
}

function ActionRow({
  icon,
  label,
  detail,
  destructive,
  disabled,
  busy,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  detail: string;
  destructive?: boolean;
  disabled?: boolean;
  busy?: boolean;
  onClick?: () => void;
}) {
  const { t } = useTranslation("mobile");
  const content = (
    <>
      <span className={`grid h-8 w-8 flex-none place-items-center rounded-md ${destructive ? "bg-[var(--app-status-danger-bg)] text-[var(--app-status-danger)]" : "bg-[var(--app-hover)] text-[var(--app-text-secondary)]"}`}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[13px] font-semibold ${disabled ? "text-[var(--app-text-tertiary)]" : destructive ? "text-[var(--app-status-danger)]" : "text-[var(--app-text-primary)]"}`}>{busy ? t("sheet.busy") : label}</span>
        <span className="mt-0.5 block truncate text-[11px] text-[var(--app-text-tertiary)]">{detail}</span>
      </span>
      <ChevronRight className="h-4 w-4 flex-none text-[var(--app-text-tertiary)]" />
    </>
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} disabled={disabled || busy} className="flex w-full items-center gap-2 border-b border-[var(--app-border)] px-3 py-2.5 text-left last:border-b-0 active:bg-[var(--app-hover)] disabled:cursor-not-allowed disabled:opacity-70">
        {content}
      </button>
    );
  }

  return (
    <div className={`flex items-center gap-2 border-b border-[var(--app-border)] px-3 py-2.5 last:border-b-0 ${disabled ? "opacity-70" : ""}`}>
      {content}
    </div>
  );
}
