import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LibraryBig, MessageSquareText, Pencil, Plus, Terminal, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useQuickCommandsStore } from "@/stores";
import type { QuickCommandDraft, QuickCommandScope, ScopedQuickCommand } from "@/types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import QuickCommandDialog from "./QuickCommandDialog";

export default function QuickCommandsSection() {
  const { t } = useTranslation(["settings", "common"]);
  const commands = useQuickCommandsStore((state) => state.commands);
  const activeProjectPath = useQuickCommandsStore((state) => state.activeProjectPath);
  const activeWorkspaceName = useQuickCommandsStore((state) => state.activeWorkspaceName);
  const loading = useQuickCommandsStore((state) => state.loading);
  const load = useQuickCommandsStore((state) => state.load);
  const create = useQuickCommandsStore((state) => state.create);
  const update = useQuickCommandsStore((state) => state.update);
  const remove = useQuickCommandsStore((state) => state.remove);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ScopedQuickCommand | null>(null);
  const showLoadingSkeleton = useDelayedLoading(loading && commands.length === 0);

  useEffect(() => {
    void load({
      projectPath: activeProjectPath ?? undefined,
      workspaceName: activeWorkspaceName ?? undefined,
    }).catch((error) => {
      toast.error(t("quickCommands.loadFailed", { error: String(error) }));
    });
  }, [activeProjectPath, activeWorkspaceName, load, t]);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (command: ScopedQuickCommand) => {
    setEditing(command);
    setDialogOpen(true);
  };

  const save = async (draft: QuickCommandDraft, scope: QuickCommandScope) => {
    try {
      if (!editing) {
        await create(draft, scope);
      } else if (editing.scope === scope) {
        await update(editing.id, draft, scope);
      } else {
        await create(draft, scope);
        await remove(editing.id, editing.scope);
      }
      toast.success(t(editing ? "quickCommands.updated" : "quickCommands.created"));
    } catch (error) {
      toast.error(t("quickCommands.saveFailed", { error: String(error) }));
      throw error;
    }
  };

  const deleteCommand = async (command: ScopedQuickCommand) => {
    if (!window.confirm(t("quickCommands.deleteConfirm", { name: command.name }))) return;
    try {
      await remove(command.id, command.scope);
      toast.success(t("quickCommands.deleted"));
    } catch (error) {
      toast.error(t("quickCommands.deleteFailed", { error: String(error) }));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-settings-section="quick-commands-root">
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--app-border)] py-6">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-[var(--app-text-primary)]">
            {t("quickCommands.title")}
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--app-text-tertiary)]">
            {t("quickCommands.description")}
          </p>
        </div>
        <Button data-testid="quick-command-add" size="sm" variant="outline" onClick={openCreate}>
          <Plus />
          {t("quickCommands.add")}
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto py-5">
        {loading && commands.length === 0 ? (
          showLoadingSkeleton ? (
            <div
              className="overflow-hidden rounded-md border border-[var(--app-border)]"
              aria-busy="true"
              aria-hidden="true"
              data-testid="quick-commands-skeleton"
            >
              {Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={i}
                  className="flex min-h-16 items-center gap-3 border-b border-[var(--app-border)] px-4 py-3 last:border-b-0"
                >
                  <Skeleton className="size-4 shrink-0 rounded" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <Skeleton className="h-3.5 w-40" />
                    <Skeleton className="h-3 w-56" />
                  </div>
                </div>
              ))}
            </div>
          ) : null
        ) : commands.length === 0 ? (
          <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-center">
            <LibraryBig className="size-8 text-[var(--app-text-tertiary)]" strokeWidth={1.5} />
            <div>
              <p className="text-sm font-medium text-[var(--app-text-secondary)]">
                {t("quickCommands.emptyTitle")}
              </p>
              <p className="mt-1 text-xs text-[var(--app-text-tertiary)]">
                {t("quickCommands.emptyDescription")}
              </p>
            </div>
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-[var(--app-border)] bg-[var(--app-panel-bg)]">
            {commands.map((command) => {
              const KindIcon = command.kind === "terminal" ? Terminal : MessageSquareText;
              return (
                <div
                  key={`${command.scope}-${command.id}`}
                  className="flex min-h-16 items-center gap-3 border-b border-[var(--app-border)] px-4 py-3 last:border-b-0"
                >
                  <KindIcon className="size-4 shrink-0 text-[var(--app-text-tertiary)]" />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium text-[var(--app-text-primary)]">
                        {command.name}
                      </span>
                      <span className="shrink-0 rounded-full border border-[var(--app-border)] px-2 py-0.5 text-[11px] text-[var(--app-text-tertiary)]">
                        {t(`quickCommands.scope.${command.scope}`)}
                      </span>
                    </div>
                    <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-[var(--app-text-tertiary)]">
                      <code className="truncate">{command.text}</code>
                      <span className="shrink-0">{t(`quickCommands.target.${command.target}`)}</span>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("quickCommands.editCommand", { name: command.name })}
                    title={t("edit", { ns: "common" })}
                    onClick={() => openEdit(command)}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("quickCommands.deleteCommand", { name: command.name })}
                    title={t("delete", { ns: "common" })}
                    onClick={() => void deleteCommand(command)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <QuickCommandDialog
        open={dialogOpen}
        command={editing}
        activeProjectPath={activeProjectPath}
        activeWorkspaceName={activeWorkspaceName}
        onOpenChange={setDialogOpen}
        onSave={save}
      />
    </div>
  );
}
