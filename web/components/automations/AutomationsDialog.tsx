import { Suspense } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { lazyWithRetry } from "@/lib/lazyRetry";
import { useAutomationsDialogStore } from "@/stores/useAutomationsDialogStore";

const AutomationsSection = lazyWithRetry(
  () => import("@/components/settings/AutomationsSection"),
  "AutomationsSection",
);

/** 自动化独立弹窗（不再挂在设置里）。标题与说明由 AutomationsSection 自己的头部卡片展示。 */
export default function AutomationsDialog() {
  const { t } = useTranslation("settings");
  const open = useAutomationsDialogStore((s) => s.open);
  const closeDialog = useAutomationsDialogStore((s) => s.closeDialog);
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) closeDialog(); }}>
      <DialogContent
        data-testid="automations-dialog"
        className="flex max-h-[85vh] flex-col overflow-hidden border-[var(--app-border)] bg-[var(--app-content)] p-5 sm:max-w-4xl"
      >
        <DialogTitle className="sr-only">{t("automations.title")}</DialogTitle>
        <DialogDescription className="sr-only">{t("automations.description")}</DialogDescription>
        <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto pr-1">
          {open ? (
            <Suspense fallback={null}>
              <AutomationsSection />
            </Suspense>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
