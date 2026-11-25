// 设置 → 设备与访问 → Tailscale：检测本机 tailscale 状态并给出 serve 命令/地址（从 WebAccessSection 拆出）。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { toastErr, toastOk } from "@/lib/feedback";
import { Button } from "@/components/ui/button";
import { settingsService } from "@/services";
import type { TailscaleStatus } from "@/types";
import { SettingsBlock, SettingsHint, SettingsSection } from "./layout";
import TailscaleServeControls from "./TailscaleServeControls";

const STATUS_LINE_CLASS = "m-0 text-[length:var(--text-small)] leading-5";

export default function WebAccessTailscaleSection({ port }: { port: number }) {
  const { t } = useTranslation("settings");
  const [tailscale, setTailscale] = useState<TailscaleStatus | null>(null);
  const [detectingTailscale, setDetectingTailscale] = useState(false);

  async function detectTailscale() {
    setDetectingTailscale(true);
    try {
      setTailscale(await settingsService.detectTailscaleStatus());
    } catch (error) {
      toastErr(t("webAccessSection.errors.tailscaleDetectionFailed", { error: String(error) }));
    } finally {
      setDetectingTailscale(false);
    }
  }

  async function copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toastOk(t("webAccessSection.errors.copied", { label }));
    } catch (error) {
      toastErr(t("webAccessSection.errors.copyFailed", { error: String(error) }));
    }
  }

  const tailscaleCommand = `tailscale serve --bg --https=443 http://127.0.0.1:${port}`;

  return (
    <SettingsSection
      sectionId="web-access-tailscale"
      title={t("webAccessSection.tailscale.title")}
      actions={(
        <Button type="button" variant="ghost" size="sm" onClick={() => void detectTailscale()} disabled={detectingTailscale}>
          <RefreshCw className={`w-3.5 h-3.5 mr-1 ${detectingTailscale ? "animate-spin" : ""}`} />
          {t("webAccessSection.tailscale.detect")}
        </Button>
      )}
    >
      <SettingsBlock className="flex flex-col gap-2 py-3">
        <SettingsHint>{t("webAccessSection.tailscale.description")}</SettingsHint>
        {tailscale && !tailscale.installed && (
          <p className={STATUS_LINE_CLASS} style={{ color: "var(--app-text-secondary)" }}>
            {t("webAccessSection.tailscale.cliNotFound")}
          </p>
        )}
        {tailscale?.installed && tailscale.backendState !== "Running" && (
          <p className={STATUS_LINE_CLASS} style={{ color: "var(--app-text-secondary)" }}>
            {t("webAccessSection.tailscale.notRunning", {
              state: tailscale.backendState
                ? t("webAccessSection.tailscale.stateSuffix", { state: tailscale.backendState })
                : "",
            })} <code>tailscale up</code> {t("webAccessSection.tailscale.login")}
          </p>
        )}
        {tailscale?.installed && tailscale.backendState === "Running" && (
          <>
            <TailscaleServeControls onCopy={(text) => void copyText(text, t("webAccessSection.tailscale.address"))} />
            <CopyableLine
              text={tailscaleCommand}
              buttonLabel={t("webAccessSection.tailscale.copyCommand")}
              onCopy={() => void copyText(tailscaleCommand, t("webAccessSection.tailscale.command"))}
            />
            {tailscale.dnsName && (
              <CopyableLine
                text={`https://${tailscale.dnsName}`}
                buttonLabel={t("webAccessSection.tailscale.copyAddress")}
                onCopy={() => void copyText(`https://${tailscale.dnsName}`, t("webAccessSection.tailscale.address"))}
              />
            )}
            <SettingsHint>
              {t("webAccessSection.tailscale.tailnetHint")} <code>tailscale serve reset</code>
              {t("webAccessSection.tailscale.tailnetHintEnd")}
            </SettingsHint>
          </>
        )}
      </SettingsBlock>
    </SettingsSection>
  );
}

/** 等宽只读命令/地址 + 复制按钮。 */
function CopyableLine({ text, buttonLabel, onCopy }: { text: string; buttonLabel: string; onCopy: () => void }) {
  return (
    <div className="grid grid-cols-[1fr_auto] gap-2 items-center">
      <code
        className="px-2 py-1.5 rounded-md text-[length:var(--text-small)] font-mono overflow-x-auto whitespace-nowrap"
        style={{ border: "1px solid var(--app-border)", background: "var(--app-content)", color: "var(--app-text-primary)" }}
      >
        {text}
      </code>
      <Button type="button" variant="secondary" size="sm" onClick={onCopy}>
        {buttonLabel}
      </Button>
    </div>
  );
}
