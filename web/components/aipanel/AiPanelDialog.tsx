import { useTranslation } from "react-i18next";
import AiPanelView from "@/components/aipanel/AiPanelView";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDialogStore } from "@/stores/useDialogStore";

export default function AiPanelDialog() {
  const { t } = useTranslation("sidebar");
  const open = useDialogStore((state) => state.aiPanelOpen);
  const close = useDialogStore((state) => state.closeAiPanel);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && close()}>
      <DialogContent
        resizable
        className="h-[78vh] w-[76vw] max-h-[92vh] max-w-[95vw] min-w-[420px] overflow-hidden p-0"
      >
        <DialogTitle className="sr-only">{t("moduleNames.aiPanel")}</DialogTitle>
        <DialogDescription className="sr-only">
          {t("aiPanel.dialogDescription")}
        </DialogDescription>
        <AiPanelView />
      </DialogContent>
    </Dialog>
  );
}
