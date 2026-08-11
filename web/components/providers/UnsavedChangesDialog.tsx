import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface UnsavedChangesDialogProps {
  open: boolean;
  onCancel: () => void;
  onDiscard: () => void;
}

export default function UnsavedChangesDialog({
  open,
  onCancel,
  onDiscard,
}: UnsavedChangesDialogProps) {
  const { t } = useTranslation("common");

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onCancel()}>
      <DialogContent className="sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("unsavedChangesTitle")}</DialogTitle>
          <DialogDescription>{t("unsavedChangesDescription")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" onClick={onCancel}>
            {t("keepEditing")}
          </Button>
          <Button variant="destructive" onClick={onDiscard}>
            {t("discardChanges")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
