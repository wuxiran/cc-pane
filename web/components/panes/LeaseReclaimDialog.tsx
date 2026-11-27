// 「抢回写权限」确认对话框：挂载点在 AppDialogs（应用根部常驻），由
// `requestLeaseReclaim` 打开（标签右键 / 终端区右键 / 只读横幅按钮）。
// 失败结论需要用户阅读并决定是否重试，按风格宪法留在对话框内联展示，不用 toast；
// 成功是瞬态确认，关闭对话框后 toast。
import { useEffect, useState } from "react";
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
import { toastOk } from "@/lib/feedback";
import { reclaimSessionLease, useLeaseReclaimStore } from "@/hooks/leaseReclaim";

export default function LeaseReclaimDialog() {
  const { t } = useTranslation("panes");
  const sessionId = useLeaseReclaimStore((s) => s.sessionId);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 每次换目标会话都从干净状态开始，旧错误不得串到新会话上。
  useEffect(() => {
    setError(null);
    setRunning(false);
  }, [sessionId]);

  const close = () => {
    if (running) return;
    useLeaseReclaimStore.getState().close();
  };

  const confirm = async () => {
    if (!sessionId || running) return;
    setError(null);
    setRunning(true);
    try {
      const result = await reclaimSessionLease(sessionId);
      if (result === "reclaimed") {
        useLeaseReclaimStore.getState().close();
        toastOk(t("leaseReclaim.success"));
        return;
      }
      setError(t(`leaseReclaim.error.${result}`));
    } catch {
      setError(t("leaseReclaim.error.failed"));
    } finally {
      setRunning(false);
    }
  };

  return (
    <AlertDialog open={sessionId !== null} onOpenChange={(next) => { if (!next) close(); }}>
      <AlertDialogContent data-testid="lease-reclaim-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("leaseReclaim.title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("leaseReclaim.description")}</AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <p
            role="alert"
            data-testid="lease-reclaim-error"
            className="text-xs"
            style={{ color: "var(--app-status-danger)" }}
          >
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={running}>{t("cancel", { ns: "common" })}</AlertDialogCancel>
          <AlertDialogAction
            disabled={running}
            data-testid="lease-reclaim-confirm"
            onClick={(event) => {
              // 默认会立即关窗；执行结果（尤其失败）要留在对话框里展示。
              event.preventDefault();
              void confirm();
            }}
          >
            {running ? t("leaseReclaim.running") : t("leaseReclaim.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
