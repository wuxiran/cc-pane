import { Suspense } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { lazyWithRetry } from "@/lib/lazyRetry";
import { useAutomationsDialogStore } from "@/stores/useAutomationsDialogStore";

const AutomationsWorkspace = lazyWithRetry(
  () => import("./AutomationsWorkspace"),
  "AutomationsWorkspace",
);

/** 定时任务独立弹窗（不挂在设置里）：左栏任务列表 + 右栏模板/详情/编辑，尺寸与设置弹窗一致。 */
export default function AutomationsDialog() {
  const { t } = useTranslation("settings");
  const open = useAutomationsDialogStore((s) => s.open);
  const closeDialog = useAutomationsDialogStore((s) => s.closeDialog);
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) closeDialog(); }}>
      <DialogContent
        data-testid="automations-dialog"
        resizable
        className="shape-panel !flex flex-col !gap-0 overflow-hidden !rounded-lg border-[var(--app-border)] bg-[var(--app-content)] !p-0 shadow-2xl"
        style={{
          width: "88vw",
          height: "82vh",
          maxWidth: "calc(100vw - 2rem)",
          maxHeight: "calc(100vh - 2rem)",
        }}
      >
        <DialogTitle className="sr-only">{t("automations.panelTitle")}</DialogTitle>
        <DialogDescription className="sr-only">{t("automations.description")}</DialogDescription>
        {open ? (
          <Suspense fallback={null}>
            <AutomationsWorkspace />
          </Suspense>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
