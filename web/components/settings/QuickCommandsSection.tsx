import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LibraryBig, MessageSquareText, Pencil, Plus, Terminal, Trash2 } from "lucide-react";
import { toastErr, toastOk } from "@/lib/feedback";
import { useQuickCommandsStore } from "@/stores";
import type { QuickCommandDraft, QuickCommandScope, ScopedQuickCommand } from "@/types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import QuickCommandDialog from "./QuickCommandDialog";
import { nativeConfirm } from "@/services/nativeDialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SettingsBlock, SettingsHint, SettingsRow, SettingsSection } from "./layout";

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
      toastErr(t("quickCommands.loadFailed", { error: String(error) }));
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
      toastOk(t(editing ? "quickCommands.updated" : "quickCommands.created"));
    } catch (error) {
      toastErr(t("quickCommands.saveFailed", { error: String(error) }));
      throw error;
    }
  };

  const deleteCommand = async (command: ScopedQuickCommand) => {
    if (!await nativeConfirm(t("quickCommands.deleteConfirm", { name: command.name }))) return;
    try {
      await remove(command.id, command.scope);
      toastOk(t("quickCommands.deleted"));
    } catch (error) {
      toastErr(t("quickCommands.deleteFailed", { error: String(error) }));
    }
  };

  const addButton = (
    <Button data-testid="quick-command-add" size="sm" variant="outline" onClick={openCreate}>
      <Plus />
      {t("quickCommands.add")}
    </Button>
  );

  return (
    <>
      <SettingsSection
        title={t("quickCommands.title")}
        description={t("quickCommands.description")}
        actions={addButton}
      >
        {loading && commands.length === 0 ? (
          showLoadingSkeleton ? (
            <div
              className="flex flex-col divide-y divide-[var(--app-border)]"
              aria-busy="true"
              aria-hidden="true"
              data-testid="quick-commands-skeleton"
            >
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3">
                  <Skeleton className="size-4 shrink-0 rounded" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <Skeleton className="h-3.5 w-40" />
                    <Skeleton className="h-3 w-56" />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <SettingsBlock className="min-h-16">{null}</SettingsBlock>
          )
        ) : commands.length === 0 ? (
          <SettingsBlock className="flex flex-col items-center justify-center gap-3 py-10 text-center">
            <LibraryBig className="size-6 text-[var(--app-text-tertiary)]" strokeWidth={1.5} aria-hidden="true" />
            <div>
              <p className="m-0 text-[length:var(--text-row)] font-medium text-[var(--app-text-secondary)]">
                {t("quickCommands.emptyTitle")}
              </p>
              <SettingsHint className="mt-1">{t("quickCommands.emptyDescription")}</SettingsHint>
            </div>
          </SettingsBlock>
        ) : (
          commands.map((command) => (
            <SettingsRow
              key={`${command.scope}-${command.id}`}
              icon={command.kind === "terminal" ? Terminal : MessageSquareText}
              title={(
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{command.name}</span>
                  <span className="shrink-0 rounded-full border border-[var(--app-border)] px-2 py-0.5 text-[length:var(--text-caption)] font-normal text-[var(--app-text-tertiary)]">
                    {t(`quickCommands.scope.${command.scope}`)}
                  </span>
                </span>
              )}
              description={(
                <span className="flex min-w-0 items-center gap-2">
                  <code className="truncate font-mono">{command.text}</code>
                  <span className="shrink-0">{t(`quickCommands.target.${command.target}`)}</span>
                </span>
              )}
              control={(
                <>
                  <Tooltip><TooltipTrigger asChild><Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("quickCommands.editCommand", { name: command.name })}
                    onClick={() => openEdit(command)}
                  >
                    <Pencil />
                  </Button></TooltipTrigger><TooltipContent>{t("edit", { ns: "common" })}</TooltipContent></Tooltip>
                  <Tooltip><TooltipTrigger asChild><Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("quickCommands.deleteCommand", { name: command.name })}
                    onClick={() => void deleteCommand(command)}
                  >
                    <Trash2 />
                  </Button></TooltipTrigger><TooltipContent>{t("delete", { ns: "common" })}</TooltipContent></Tooltip>
                </>
              )}
            />
          ))
        )}
      </SettingsSection>

      <QuickCommandDialog
        open={dialogOpen}
        command={editing}
        activeProjectPath={activeProjectPath}
        activeWorkspaceName={activeWorkspaceName}
        onOpenChange={setDialogOpen}
        onSave={save}
      />
    </>
  );
}
