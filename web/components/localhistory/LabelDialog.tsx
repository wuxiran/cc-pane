import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface LabelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  labelName: string;
  setLabelName: (name: string) => void;
  onConfirm: () => void;
}

export default function LabelDialog({
  open,
  onOpenChange,
  labelName,
  setLabelName,
  onConfirm,
}: LabelDialogProps) {
  const { t } = useTranslation(["dialogs", "common"]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("addTag")}</DialogTitle>
        </DialogHeader>
        <div className="py-4">
          <Input
            value={labelName}
            onChange={(e) => setLabelName(e.target.value)}
            placeholder={t("tagNamePlaceholder")}
            onKeyDown={(e) => { if (e.key === "Enter") onConfirm(); }}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>{t("common:cancel")}</Button>
          <Button onClick={onConfirm}>{t("common:confirm")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
