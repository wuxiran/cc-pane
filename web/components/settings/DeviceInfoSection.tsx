// 设置 → 设备与访问 → 本机：主机名（卡片标题）/ 操作系统 / 应用版本 / 本机 Web 地址 / 更新状态。
// 主机名与系统版本来自桌面端命令 `get_local_device_info`；Web 端或命令失败时标题退回「本机」、系统退回 UA 推断。
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { RefreshCw } from "lucide-react";
import packageJson from "../../../package.json";
import { Button } from "@/components/ui/button";
import { getLocalDeviceInfo } from "@/services/deviceService";
import { isTauriRuntime } from "@/services/runtime";
import { useUpdateStore } from "@/stores";
import type { WebAccessStatus } from "@/types";
import type { LocalDeviceInfo } from "@/types/device";
import { SettingsRow, SettingsSection, SettingsValue } from "./layout";

type CheckPhase = "idle" | "checking" | "done";

/** 从 WebView 的 UA 推断操作系统（无后端调用）。 */
export function describeLocalOs(userAgent: string, platform: string): string {
  if (/Mac/i.test(userAgent) || /Mac/i.test(platform)) return "macOS";
  if (/Windows/i.test(userAgent) || /Win/i.test(platform)) return "Windows";
  if (/Linux/i.test(userAgent) || /Linux/i.test(platform)) return "Linux";
  return platform || "—";
}

function useAppVersion(): string {
  const [version, setVersion] = useState("...");
  useEffect(() => {
    if (!isTauriRuntime()) {
      setVersion(packageJson.version);
      return;
    }
    getVersion().then(setVersion).catch(() => setVersion(packageJson.version));
  }, []);
  return version;
}

/** 桌面端读一次本机信息；失败 / Web 端为 null。 */
function useLocalDeviceInfo(): LocalDeviceInfo | null {
  const [info, setInfo] = useState<LocalDeviceInfo | null>(null);
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => getLocalDeviceInfo())
      .then((result) => { if (!cancelled) setInfo(result); })
      .catch((error) => console.warn("[DeviceInfoSection] get_local_device_info failed:", error));
    return () => { cancelled = true; };
  }, []);
  return info;
}

/** 打开本页时静默检查一次（结果写入 useUpdateStore）；按钮走与「关于」相同的交互式检查。 */
function useUpdateCheck() {
  const [phase, setPhase] = useState<CheckPhase>("idle");
  const startedAtRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    startedAtRef.current = new Date().toISOString();
    setPhase("checking");
    import("@/services/updaterService")
      .then(({ checkUpdateSilent }) => checkUpdateSilent())
      .catch(() => {})
      .finally(() => { if (!cancelled) setPhase("done"); });
    return () => { cancelled = true; };
  }, []);

  const checkNow = async () => {
    startedAtRef.current = new Date().toISOString();
    setPhase("checking");
    try {
      const { checkForAppUpdates } = await import("@/services/updaterService");
      await checkForAppUpdates(true);
    } catch (error) {
      console.error("[DeviceInfoSection] update check failed:", error);
    } finally {
      setPhase("done");
    }
  };

  return { phase, startedAt: startedAtRef.current, checkNow };
}

export default function DeviceInfoSection({ status }: { status: WebAccessStatus | null }) {
  const { t } = useTranslation("settings");
  const version = useAppVersion();
  const localInfo = useLocalDeviceInfo();
  const hostname = localInfo?.hostname?.trim() || null;
  const { phase, startedAt, checkNow } = useUpdateCheck();
  const updateAvailable = useUpdateStore((s) => s.available);
  const updateVersion = useUpdateStore((s) => s.version);
  const lastCheckFailedAt = useUpdateStore((s) => s.lastCheckFailedAt);
  const isDesktop = isTauriRuntime();
  const failedThisCheck = Boolean(lastCheckFailedAt && startedAt && lastCheckFailedAt >= startedAt);

  let updateText: string;
  if (!isDesktop) updateText = t("deviceAccess.local.desktopOnly");
  else if (updateAvailable && updateVersion) updateText = t("deviceAccess.local.updateAvailable", { version: updateVersion });
  else if (phase === "checking") updateText = t("deviceAccess.local.checking");
  else if (phase === "done" && failedThisCheck) updateText = t("deviceAccess.local.checkFailed");
  else if (phase === "done") updateText = t("deviceAccess.local.upToDate");
  else updateText = t("deviceAccess.local.notChecked");

  return (
    <SettingsSection
      sectionId="web-access-device"
      title={hostname ?? t("deviceAccess.local.title")}
      description={hostname ? t("deviceAccess.local.title") : undefined}
      data-testid="device-info-section"
    >
      <SettingsRow
        title={t("deviceAccess.local.os")}
        control={(
          <span data-testid="device-info-os" className="text-[length:var(--text-row)] text-[var(--app-text-secondary)]">
            {localInfo?.os?.trim() || describeLocalOs(navigator.userAgent, navigator.platform)}
          </span>
        )}
      />
      <SettingsRow
        title={t("deviceAccess.local.version")}
        control={<span className="font-mono text-[length:var(--text-row)] text-[var(--app-text-secondary)]">v{version}</span>}
      />
      {status?.running ? (
        <SettingsRow title={t("deviceAccess.local.webUrl")} description={t("deviceAccess.local.webUrlHint")}>
          <SettingsValue title={status.url}>{status.url}</SettingsValue>
        </SettingsRow>
      ) : null}
      <SettingsRow
        title={t("deviceAccess.local.update")}
        description={(
          <span
            data-testid="device-info-update-status"
            className={updateAvailable && updateVersion ? "text-[var(--app-accent)]" : undefined}
          >
            {updateText}
          </span>
        )}
        control={isDesktop ? (
          <Button type="button" variant="ghost" size="sm" disabled={phase === "checking"} onClick={() => void checkNow()}>
            <RefreshCw className={`mr-1 h-3.5 w-3.5 ${phase === "checking" ? "animate-spin" : ""}`} />
            {t("checkUpdate")}
          </Button>
        ) : undefined}
      />
    </SettingsSection>
  );
}
