import "@/i18n/sessionReviewResources";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import SessionReviewContent, { type SessionReviewContentProps } from "./SessionReviewContent";

/** Compatibility wrapper for modal entry points; workbench tabs embed the same content. */
export default function SessionReviewPanel({ onOpenChange, ...props }: Omit<SessionReviewContentProps, "onOpenFile"> & { onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation("review");
  return <Dialog open={props.open} onOpenChange={onOpenChange}>
    <DialogContent className="flex h-[min(90vh,1000px)] w-[96vw] flex-col overflow-hidden rounded-2xl border-[var(--app-border)] bg-[var(--app-content)] p-0 shadow-2xl sm:max-w-[1440px]">
      <DialogTitle className="sr-only">{t("title")}</DialogTitle>
      <DialogDescription className="sr-only">{props.projectPath}</DialogDescription>
      <SessionReviewContent {...props} onOpenFile={() => onOpenChange(false)} />
    </DialogContent>
  </Dialog>;
}
