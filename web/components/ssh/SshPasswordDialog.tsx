import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, LockKeyhole } from "lucide-react";
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
import { sshFileService } from "@/services";
import type { SshMachine } from "@/types";
import { getErrorMessage } from "@/utils";

interface SshPasswordDialogProps {
  machine: SshMachine | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: (remember: boolean) => void | Promise<void>;
}

export default function SshPasswordDialog({
  machine,
  open,
  onOpenChange,
  onConnected,
}: SshPasswordDialogProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPassword("");
    setRemember(true);
    setError(null);
  }, [machine?.id, open]);

  const handleSubmit = useCallback(async () => {
    if (!machine || password.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await sshFileService.configurePassword(machine.id, password, remember);
      await onConnected(remember);
      onOpenChange(false);
    } catch (submitError) {
      setError(getErrorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  }, [machine, onConnected, onOpenChange, password, remember]);

  if (!machine) return null;

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !submitting && onOpenChange(nextOpen)}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <LockKeyhole className="h-4 w-4" />
            {t("sshFiles.passwordTitle")}
          </DialogTitle>
          <DialogDescription className="break-all text-xs">
            {t("sshFiles.passwordDescription", {
              target: `${machine.user || "root"}@${machine.host}:${machine.port}`,
            })}
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          type="password"
          aria-label={t("sshFiles.password")}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && handleSubmit()}
          placeholder={t("sshFiles.passwordPlaceholder")}
        />
        <label className="flex items-center gap-2 text-xs text-[var(--app-text-secondary)]">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
          />
          <span>{t("sshFiles.rememberPassword")}</span>
        </label>
        {error && (
          <p role="alert" className="break-words text-xs text-[var(--app-status-danger)]">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t("cancel", { ns: "common" })}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || password.length === 0}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("sshFiles.connect")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
