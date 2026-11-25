import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import packageJson from "../../../package.json";
import { useUpdateStore } from "@/stores";
import { logService } from "@/services";
import { settingsService } from "@/services/settingsService";
import type { UninstallCleanupReport } from "@/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RefreshCw, FolderOpen, ShieldCheck } from "lucide-react";
import { isTauriRuntime } from "@/services/runtime";
import { SettingsRow, SettingsSection } from "./layout";

export default function AboutSection() {
  const { t } = useTranslation("settings");
  const [version, setVersion] = useState("...");
  const [checking, setChecking] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const [cleanupReport, setCleanupReport] = useState<UninstallCleanupReport | null>(null);
  const updateAvailable = useUpdateStore((s) => s.available);
  const updateVersion = useUpdateStore((s) => s.version);
  const lastCheckError = useUpdateStore((s) => s.lastCheckError);
  const lastCheckFailedAt = useUpdateStore((s) => s.lastCheckFailedAt);
  const cleanupReportLabels = {
    cleaned: t("cleanupReportCleaned"),
    skipped: t("cleanupReportSkipped"),
    failed: t("cleanupReportFailed"),
  };

  useEffect(() => {
    if (!isTauriRuntime()) {
      setVersion(packageJson.version);
      return;
    }
    getVersion().then(setVersion);
  }, []);

  const handleCheckUpdate = async () => {
    setChecking(true);
    try {
      // 动态 import 防止 updater 插件未注册时导致整个组件不渲染
      if (!isTauriRuntime()) return;
      const { checkForAppUpdates } = await import("@/services/updaterService");
      await checkForAppUpdates(true);
    } catch (error) {
      console.error("[AboutSection] 检查更新失败:", error);
    } finally {
      setChecking(false);
    }
  };

  const handleCleanup = async () => {
    setCleaning(true);
    setCleanupError(null);
    try {
      const report = await settingsService.cleanupBeforeUninstall();
      setCleanupReport(report);
      setCleanupOpen(false);
    } catch (error) {
      setCleanupError(error instanceof Error ? error.message : String(error));
    } finally {
      setCleaning(false);
    }
  };

  const isDesktop = isTauriRuntime();
  const showUpdateBanner = Boolean(updateAvailable && updateVersion);
  const updateNotices = (
    <>
      {/* 更新状态提示 */}
      {showUpdateBanner && (
        <p
          className="m-0 rounded-md px-3 py-2 text-[length:var(--text-small)]"
          style={{
            background: "var(--app-active-bg)",
            color: "var(--app-accent)",
            border: "1px solid var(--app-accent)",
          }}
        >
          {t("newVersionAvailable", { version: updateVersion })}
        </p>
      )}

      {/* 静默检查失败：不弹任何东西，只在这里留一条可查的痕迹（docs/59 / L7 任务 2）。
          「需注意但可等」→ 用 warning 而非 danger（docs/46 §状态色映射）。 */}
      {lastCheckError && (
        <p
          className="m-0 break-all rounded-md px-3 py-2 text-[length:var(--text-small)]"
          style={{
            background: "var(--app-status-warning-bg)",
            color: "var(--app-status-warning)",
            border: "1px solid var(--app-status-warning-border)",
          }}
        >
          {t("updateCheckFailed", {
            time: lastCheckFailedAt ? new Date(lastCheckFailedAt).toLocaleString() : "",
            reason: lastCheckError,
          })}
        </p>
      )}
    </>
  );

  return (
    <>
      <SettingsSection>
        {([
          [t("appName"), "CC-Panes"],
          [t("version"), `v${version}`],
          [t("techStack"), "Tauri 2 + React 19 + TypeScript"],
        ] as const).map(([label, value]) => (
          <SettingsRow
            key={label}
            title={label}
            control={(
              <span className="select-text text-[length:var(--text-row)] text-[var(--app-text-secondary)]">{value}</span>
            )}
          />
        ))}
        <SettingsRow title={t("description")} description={t("appDescription")} />
      </SettingsSection>

      {(isDesktop || showUpdateBanner || Boolean(lastCheckError)) && (
        <SettingsSection title={t("aboutGroups.maintenance")}>
          <SettingsRow
            title={t("checkUpdate")}
            description={t("aboutGroups.checkUpdateDesc")}
            control={isDesktop ? (
              <Button variant="outline" size="sm" disabled={checking} onClick={handleCheckUpdate}>
                <RefreshCw className={`w-4 h-4 mr-1.5 ${checking ? "animate-spin" : ""}`} />
                {checking ? t("checking") : t("checkUpdate")}
              </Button>
            ) : undefined}
          >
            {showUpdateBanner || lastCheckError ? updateNotices : null}
          </SettingsRow>

          {isDesktop && (
            <SettingsRow
              title={t("openLogDir")}
              description={t("aboutGroups.openLogDirDesc")}
              control={(
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    try {
                      await logService.openLogDir();
                    } catch (error) {
                      console.error("[AboutSection] Failed to open log dir:", error);
                    }
                  }}
                >
                  <FolderOpen className="w-4 h-4 mr-1.5" />
                  {t("openLogDir")}
                </Button>
              )}
            />
          )}

          {isDesktop && (
            <SettingsRow
              title={t("cleanupBeforeUninstall")}
              description={t("cleanupConfirmDescription")}
              control={(
                <Button variant="outline" size="sm" onClick={() => setCleanupOpen(true)}>
                  <ShieldCheck className="w-4 h-4 mr-1.5" />
                  {t("cleanupBeforeUninstall")}
                </Button>
              )}
            >
              {cleanupReport && (
                <div className="flex flex-col gap-2 text-[length:var(--text-small)]" aria-live="polite">
                  <h4 className="m-0 text-[length:var(--text-row)] font-medium text-[var(--app-text-primary)]">
                    {t("cleanupReport")}
                  </h4>
                  {(["cleaned", "skipped", "failed"] as const).map((kind) => (
                    <div key={kind}>
                      <div className="font-medium text-[var(--app-text-secondary)]">
                        {cleanupReportLabels[kind]} ({cleanupReport[kind].length})
                      </div>
                      {cleanupReport[kind].map((item) => (
                        <div key={`${kind}-${item}`} className="break-all font-mono text-[var(--app-text-primary)]">
                          {item}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </SettingsRow>
          )}
        </SettingsSection>
      )}

      <Dialog open={cleanupOpen} onOpenChange={(open) => !cleaning && setCleanupOpen(open)}>
        <DialogContent role="alertdialog" showCloseButton={!cleaning}>
          <DialogHeader>
            <DialogTitle>{t("cleanupConfirmTitle")}</DialogTitle>
            <DialogDescription>{t("cleanupConfirmDescription")}</DialogDescription>
          </DialogHeader>
          {cleanupError && (
            <div className="text-sm text-destructive break-all" role="alert">
              {cleanupError}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={cleaning} onClick={() => setCleanupOpen(false)}>
              {t("cleanupCancel")}
            </Button>
            <Button variant="destructive" disabled={cleaning} onClick={handleCleanup}>
              <ShieldCheck className="w-4 h-4 mr-1.5" />
              {cleaning ? t("cleaning") : t("cleanupNow")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
