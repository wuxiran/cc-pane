// 设置 → 设备与访问 → Tailscale：Serve 一键开启 / 关闭。只在用户点击时执行 `tailscale serve`，
// 打开页面只读一次 `tailscale serve status`。失败按原因给出可操作的说明。
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { toastErr, toastOk } from "@/lib/feedback";
import { Button } from "@/components/ui/button";
import {
  getTailscaleServeStatus,
  startTailscaleServe,
  stopTailscaleServe,
  type TailscaleServeError,
  type TailscaleServeOutcome,
  type TailscaleServeStatus,
} from "@/services/accessService";
import { SettingsHint } from "./layout";

const LINE_CLASS = "m-0 text-[length:var(--text-small)] leading-5";

export function useServeErrorText() {
  const { t } = useTranslation("settings");
  return (error: TailscaleServeError): string => {
    switch (error.kind) {
      case "notRunning":
        return t("webAccessSection.tailscale.serve.errors.notRunning", { state: error.backendState ?? "-" });
      case "needsApproval":
        return error.url
          ? t("webAccessSection.tailscale.serve.errors.needsApproval", { url: error.url })
          : t("webAccessSection.tailscale.serve.errors.needsApprovalNoUrl");
      case "permissionDenied":
      case "failed":
        return t(`webAccessSection.tailscale.serve.errors.${error.kind}`, { detail: error.detail });
      default:
        return t(`webAccessSection.tailscale.serve.errors.${error.kind}`);
    }
  };
}

export default function TailscaleServeControls({ onCopy }: { onCopy: (text: string) => void }) {
  const { t } = useTranslation("settings");
  const errorText = useServeErrorText();
  const [status, setStatus] = useState<TailscaleServeStatus | null>(null);
  const [error, setError] = useState<TailscaleServeError | null>(null);
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);

  const apply = useCallback((outcome: TailscaleServeOutcome) => {
    if (outcome.status) setStatus(outcome.status);
    setError(outcome.error);
    return outcome;
  }, []);

  useEffect(() => {
    getTailscaleServeStatus().then(apply).catch(() => {});
  }, [apply]);

  const run = async (action: "start" | "stop") => {
    setBusy(action);
    try {
      const outcome = apply(await (action === "start" ? startTailscaleServe() : stopTailscaleServe()));
      if (outcome.error) {
        toastErr(errorText(outcome.error));
      } else {
        toastOk(t(action === "start" ? "webAccessSection.tailscale.serve.enabled" : "webAccessSection.tailscale.serve.disabled"));
      }
    } catch (reason) {
      toastErr(String(reason));
    } finally {
      setBusy(null);
    }
  };

  const active = Boolean(status?.active);
  return (
    <div className="flex flex-col gap-2" data-testid="tailscale-serve-controls">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={LINE_CLASS} style={{ color: "var(--app-text-secondary)" }} data-testid="tailscale-serve-state">
          {active ? t("webAccessSection.tailscale.serve.on") : t("webAccessSection.tailscale.serve.off")}
          {active && status?.url ? <code className="ml-1 text-[var(--app-text-primary)]">{status.url}</code> : null}
        </p>
        <div className="flex items-center gap-2">
          {active && status?.url ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => onCopy(status.url ?? "")}>
              {t("webAccessSection.tailscale.copyAddress")}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant={active ? "outline" : "secondary"}
            disabled={busy !== null}
            onClick={() => void run(active ? "stop" : "start")}
            data-testid={active ? "tailscale-serve-stop" : "tailscale-serve-start"}
          >
            {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
            {t(active ? "webAccessSection.tailscale.serve.disable" : "webAccessSection.tailscale.serve.enable")}
          </Button>
        </div>
      </div>
      {error ? (
        <p className={`${LINE_CLASS} whitespace-pre-wrap break-words`} style={{ color: "var(--app-status-danger)" }} data-testid="tailscale-serve-error">
          {errorText(error)}
        </p>
      ) : null}
      <SettingsHint>{t("webAccessSection.tailscale.serve.hint")}</SettingsHint>
    </div>
  );
}
