import { useState } from "react";
import { Paintbrush } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface BatchRestyleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** How many shots will receive the restyle run. */
  eligibleCount: number;
  onSubmit: (stylePrompt: string) => Promise<void> | void;
}

/**
 * Batch restyle (转绘): one style prompt applied as image-to-image over every
 * selected shot that already has a generated image. Each restyle is a normal
 * media run; the shot then points at the new node, keeping the old one on the
 * canvas as history.
 */
export default function BatchRestyleDialog({ open, onOpenChange, eligibleCount, onSubmit }: BatchRestyleDialogProps) {
  const { t } = useTranslation("media");
  const [stylePrompt, setStylePrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!stylePrompt.trim()) return;
    setSubmitting(true);
    try {
      await onSubmit(stylePrompt.trim());
      onOpenChange(false);
      setStylePrompt("");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="batch-restyle-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Paintbrush className="size-4" style={{ color: "var(--app-accent)" }} aria-hidden="true" />
            {t("restyleTitle")}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <p className="text-xs" style={{ color: "var(--app-text-secondary)" }}>
            {t("restyleHint", { count: eligibleCount })}
          </p>
          <textarea
            className="h-24 w-full resize-none rounded-md border bg-transparent p-2 text-xs outline-none"
            style={{ borderColor: "var(--app-border)", color: "var(--app-text-primary)" }}
            data-testid="restyle-style-prompt"
            value={stylePrompt}
            placeholder={t("restylePromptPlaceholder")}
            onChange={(event) => setStylePrompt(event.target.value)}
          />
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              className="h-7 text-xs"
              disabled={submitting || !stylePrompt.trim() || eligibleCount === 0}
              onClick={() => void submit()}
            >
              {submitting ? t("restyleRunning") : t("restyleSubmit", { count: eligibleCount })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
