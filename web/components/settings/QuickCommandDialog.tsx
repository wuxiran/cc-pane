import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { CLI_TOOL_TABS } from "@/types/provider";
import type {
  QuickCommandDraft,
  QuickCommandKind,
  QuickCommandScope,
  QuickCommandTarget,
  ScopedQuickCommand,
} from "@/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

interface QuickCommandDialogProps {
  open: boolean;
  command: ScopedQuickCommand | null;
  activeProjectPath: string | null;
  activeWorkspaceName?: string | null;
  onOpenChange: (open: boolean) => void;
  onSave: (draft: QuickCommandDraft, scope: QuickCommandScope) => Promise<void>;
}

function defaultDraft(): QuickCommandDraft {
  return {
    name: "",
    kind: "terminal",
    text: "",
    appendEnter: true,
    target: "currentPane",
  };
}

export default function QuickCommandDialog({
  open,
  command,
  activeProjectPath,
  activeWorkspaceName = null,
  onOpenChange,
  onSave,
}: QuickCommandDialogProps) {
  const { t } = useTranslation(["settings", "common"]);
  const [draft, setDraft] = useState<QuickCommandDraft>(defaultDraft);
  // workspace-first：有活跃工作空间时新建默认落工作空间层
  const defaultScope: QuickCommandScope = activeWorkspaceName ? "workspace" : "global";
  const [scope, setScope] = useState<QuickCommandScope>(defaultScope);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(command ? {
      name: command.name,
      kind: command.kind,
      text: command.text,
      appendEnter: command.appendEnter,
      target: command.target,
      cliTool: command.cliTool,
    } : defaultDraft());
    setScope(command?.scope ?? defaultScope);
    setSaving(false);
  }, [command, open, defaultScope]);

  const valid = Boolean(
    draft.name.trim()
    && draft.text.trim()
    && (draft.kind !== "agentPrompt" || draft.cliTool),
  );

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    try {
      await onSave({
        ...draft,
        name: draft.name.trim(),
        text: draft.text,
        cliTool: draft.kind === "agentPrompt" ? draft.cliTool : undefined,
      }, scope);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <form className="grid gap-5" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {t(command ? "quickCommands.editTitle" : "quickCommands.newTitle")}
            </DialogTitle>
            <DialogDescription>{t("quickCommands.dialogDescription")}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2 sm:col-span-2">
              <Label htmlFor="quick-command-name">{t("quickCommands.fieldName")}</Label>
              <Input
                id="quick-command-name"
                value={draft.name}
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                autoFocus
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="quick-command-kind">{t("quickCommands.fieldKind")}</Label>
              <Select
                value={draft.kind}
                onValueChange={(next) => {
                  const kind = next as QuickCommandKind;
                  setDraft((current) => ({
                    ...current,
                    kind,
                    cliTool: kind === "agentPrompt" ? current.cliTool ?? "claude" : undefined,
                  }));
                }}
              >
                <SelectTrigger id="quick-command-kind" className="w-full bg-[var(--app-content)] text-[13px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="terminal">{t("quickCommands.kind.terminal")}</SelectItem>
                  <SelectItem value="agentPrompt">{t("quickCommands.kind.agentPrompt")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="quick-command-scope">{t("quickCommands.fieldScope")}</Label>
              <Select
                value={scope}
                onValueChange={(next) => setScope(next as QuickCommandScope)}
              >
                <SelectTrigger id="quick-command-scope" className="w-full bg-[var(--app-content)] text-[13px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem
                    value="workspace"
                    disabled={!activeWorkspaceName}
                    aria-disabled={!activeWorkspaceName}
                  >
                    {activeWorkspaceName
                      ? t("quickCommands.scope.workspaceNamed", { name: activeWorkspaceName })
                      : t("quickCommands.scope.workspace")}
                  </SelectItem>
                  <SelectItem value="global">{t("quickCommands.scope.global")}</SelectItem>
                  <SelectItem
                  value="project"
                  disabled={!activeProjectPath}
                  aria-disabled={!activeProjectPath}
                >
                  {t("quickCommands.scope.project")}
                  </SelectItem>
                </SelectContent>
              </Select>
              {!activeProjectPath && (
                <span className="text-xs text-muted-foreground">
                  {t("quickCommands.projectScopeUnavailable")}
                </span>
              )}
            </div>

            {draft.kind === "agentPrompt" && (
              <div className="grid gap-2 sm:col-span-2">
                <Label htmlFor="quick-command-cli">{t("quickCommands.fieldCliTool")}</Label>
                <Select
                  value={draft.cliTool ?? ""}
                  onValueChange={(next) => setDraft((current) => ({ ...current, cliTool: next }))}
                >
                  <SelectTrigger id="quick-command-cli" className="w-full bg-[var(--app-content)] text-[13px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CLI_TOOL_TABS.map((tool) => (
                      <SelectItem key={tool.id} value={tool.id}>
                      {t(tool.labelKey as never)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="grid gap-2 sm:col-span-2">
              <Label htmlFor="quick-command-text">{t("quickCommands.fieldText")}</Label>
              <textarea
                id="quick-command-text"
                className="min-h-28 w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={draft.text}
                onChange={(event) => setDraft((current) => ({ ...current, text: event.target.value }))}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="quick-command-target">{t("quickCommands.fieldTarget")}</Label>
              <Select
                value={draft.target}
                onValueChange={(next) => setDraft((current) => ({
                  ...current,
                  target: next as QuickCommandTarget,
                }))}
              >
                <SelectTrigger id="quick-command-target" className="w-full bg-[var(--app-content)] text-[13px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="currentPane">{t("quickCommands.target.currentPane")}</SelectItem>
                  <SelectItem value="newTab">{t("quickCommands.target.newTab")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
              <Label htmlFor="quick-command-append-enter" className="leading-snug">
                {t("quickCommands.fieldAppendEnter")}
              </Label>
              <Switch
                id="quick-command-append-enter"
                checked={draft.appendEnter}
                onCheckedChange={(appendEnter) => setDraft((current) => ({ ...current, appendEnter }))}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("cancel", { ns: "common" })}
            </Button>
            <Button type="submit" disabled={!valid || saving}>
              {saving ? t("quickCommands.saving") : t("save", { ns: "common" })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
