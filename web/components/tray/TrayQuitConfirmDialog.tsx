// 托盘「退出」确认对话框：仍有运行会话时 Rust 托盘发 tray-action/confirm-quit，
// useTrayActions 打开本对话框；确认后回调 Rust（confirm_tray_quit）执行真正的退出，
// 取消只关窗不做任何事。挂载点在 AppDialogs（应用根部常驻）。
import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { trayService } from "@/services/trayService";
import { useDialogStore } from "@/stores";
import { handleErrorSilent } from "@/utils/errorHandler";

export default function TrayQuitConfirmDialog() {
  const { t } = useTranslation("settings");
  const open = useDialogStore((s) => s.trayQuitConfirmOpen);
  const runningCount = useDialogStore((s) => s.trayQuitRunningCount);

  const close = () => useDialogStore.getState().closeTrayQuitConfirm();
  const confirm = () => {
    close();
    trayService
      .confirmTrayQuit()
      .catch((error) => handleErrorSilent(error, "confirm tray quit"));
  };

  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("trayQuitConfirmTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("trayQuitConfirmDesc", { count: runningCount })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel", { ns: "common" })}</AlertDialogCancel>
          <AlertDialogAction onClick={confirm}>
            {t("trayQuitConfirmAction")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
