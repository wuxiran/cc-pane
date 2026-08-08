import { useTranslation } from "react-i18next";
import { type LucideIcon } from "lucide-react";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { FsEntry } from "@/types/filesystem";
import type { OpenTerminalOptions, SshMachine } from "@/types";
import { buildSshDisplayPath } from "@/utils";

export type EntryDialog =
  | { kind: "file" }
  | { kind: "directory" }
  | { kind: "rename"; entry: FsEntry }
  | null;

export interface PermissionDialogState {
  entry: FsEntry;
  mode: string;
}

export function isPasswordAuthenticationError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("no saved password")
    || normalized.includes("no ssh password")
    || normalized.includes("password authentication failed")
    || normalized.includes("username/password combination invalid");
}

export function permissionsToOctal(
  permissions: string | null | undefined,
  isDir: boolean,
): string {
  if (!permissions || permissions.length < 9) return isDir ? "755" : "644";
  const bits = permissions.slice(-9);
  return [0, 3, 6]
    .map((offset) => {
      let value = 0;
      if (bits[offset] !== "-") value += 4;
      if (bits[offset + 1] !== "-") value += 2;
      if (bits[offset + 2] !== "-") value += 1;
      return value.toString();
    })
    .join("");
}

export function parentRemotePath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const separator = trimmed.lastIndexOf("/");
  return separator <= 0 ? "/" : trimmed.slice(0, separator);
}

export function buildTerminalOptions(
  machine: SshMachine,
  remotePath: string,
): OpenTerminalOptions {
  return {
    path: buildSshDisplayPath(machine, remotePath),
    machineName: machine.name,
    ssh: {
      host: machine.host,
      port: machine.port,
      user: machine.user,
      remotePath,
      identityFile: machine.identityFile,
      machineId: machine.id,
      authMethod: machine.authMethod,
    },
  };
}

export function IconButton({
  label,
  children,
  onClick,
  disabled = false,
}: {
  label: string;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)] disabled:opacity-30"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export function PanelMessage({
  icon: Icon,
  message,
  children,
  spin = false,
  danger = false,
}: {
  icon: LucideIcon;
  message: string;
  children?: React.ReactNode;
  spin?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="flex h-full min-h-32 flex-col items-center justify-center gap-2 px-4 text-center">
      <Icon
        className={`h-6 w-6 ${spin ? "animate-spin" : ""}`}
        style={{ color: danger ? "var(--app-status-danger)" : "var(--app-text-muted)" }}
      />
      <p className="max-w-sm break-words text-xs text-[var(--app-text-secondary)]">{message}</p>
      {children}
    </div>
  );
}

export function EntryNameDialog({
  dialog,
  name,
  onNameChange,
  onClose,
  onSubmit,
}: {
  dialog: EntryDialog;
  name: string;
  onNameChange: (name: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation(["sidebar", "common"]);
  const title = dialog?.kind === "rename"
    ? t("sshFiles.rename")
    : dialog?.kind === "directory"
      ? t("sshFiles.newFolder")
      : t("sshFiles.newFile");
  return (
    <Dialog open={dialog !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">
            {t("sshFiles.entryDialogDescription")}
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          aria-label={t("sshFiles.name")}
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && onSubmit()}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("cancel", { ns: "common" })}</Button>
          <Button onClick={onSubmit} disabled={!name.trim()}>{t("confirm", { ns: "common" })}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PermissionDialog({
  state,
  onChange,
  onClose,
  onSubmit,
}: {
  state: PermissionDialogState | null;
  onChange: (mode: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation(["sidebar", "common"]);
  return (
    <Dialog open={state !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("sshFiles.changePermissions")}</DialogTitle>
          <DialogDescription>{state?.entry.path}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          aria-label={t("sshFiles.permissionMode")}
          value={state?.mode ?? ""}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && onSubmit()}
          placeholder="755"
          className="font-mono"
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("cancel", { ns: "common" })}</Button>
          <Button onClick={onSubmit} disabled={!/^[0-7]{3,4}$/.test(state?.mode ?? "")}>
            {t("confirm", { ns: "common" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
