import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getErrorMessage } from "@/utils";
import type { ChatForkMode } from "@/services/chatForkService";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFork: (mode: ChatForkMode) => Promise<void>;
  allowWorktree?: boolean;
}

export default function ChatForkDialog({
  open,
  onOpenChange,
  onFork,
  allowWorktree = true,
}: Props) {
  const { t } = useTranslation("panes");
  const [mode, setMode] = useState<ChatForkMode>("same-directory");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function createFork() {
    setBusy(true);
    setError(null);
    try {
      await onFork(mode);
      onOpenChange(false);
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) {
          setError(null);
          setMode("same-directory");
          onOpenChange(next);
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("forkChat")}</DialogTitle>
          <DialogDescription>{t("forkChatDescription")}</DialogDescription>
        </DialogHeader>
        <fieldset disabled={busy} className="space-y-3">
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="chat-fork-mode"
              checked={mode === "same-directory"}
              onChange={() => setMode("same-directory")}
            />
            <span>{t("forkSameDirectory")}</span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="chat-fork-mode"
              disabled={!allowWorktree}
              checked={mode === "worktree"}
              onChange={() => setMode("worktree")}
            />
            <span>{t("forkWorktree")}</span>
          </label>
          <p className="text-xs text-[var(--app-text-secondary)]">
            {t(
              allowWorktree
                ? "forkWorktreeDescription"
                : "forkWorktreeLocalOnly",
            )}
          </p>
        </fieldset>
        {error && (
          <p role="alert" className="text-sm text-[var(--destructive)]">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {t("cancel", { ns: "common" })}
          </Button>
          <Button disabled={busy} onClick={() => void createFork()}>
            {t(busy ? "forkCreating" : "forkChat")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
