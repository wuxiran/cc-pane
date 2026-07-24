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

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-[15px] font-semibold mb-1" style={{ color: "var(--app-text-primary)" }}>
        {t("aboutTitle")}
      </h3>

      <div className="flex flex-col gap-2">
        {([
          [t("appName"), "CC-Panes"],
          [t("version"), `v${version}`],
          [t("description"), t("appDescription")],
          [t("techStack"), "Tauri 2 + React 19 + TypeScript"],
        ] as const).map(([label, value]) => (
          <div
            key={label}
            className="flex justify-between items-center py-1.5"
            style={{ borderBottom: "1px solid var(--app-border)" }}
          >
            <span className="text-[13px]" style={{ color: "var(--app-text-secondary)" }}>{label}</span>
            <span className="text-[13px] font-medium" style={{ color: "var(--app-text-primary)" }}>{value}</span>
          </div>
        ))}
      </div>

      {/* 更新状态提示 */}
      {updateAvailable && updateVersion && (
        <div
          className="flex items-center gap-2 px-3 py-2 rounded-md text-[12px]"
          style={{
            background: "var(--app-active-bg)",
            color: "var(--app-accent)",
            border: "1px solid var(--app-accent)",
          }}
        >
          <span>{t("newVersionAvailable", { version: updateVersion })}</span>
        </div>
      )}

      <div className="flex flex-wrap gap-2 mt-2">
        {isTauriRuntime() && (
        <Button
          variant="outline"
          size="sm"
          disabled={checking}
          onClick={handleCheckUpdate}
        >
          <RefreshCw className={`w-4 h-4 mr-1.5 ${checking ? "animate-spin" : ""}`} />
          {checking ? t("checking") : t("checkUpdate")}
        </Button>
        )}

        {isTauriRuntime() && (
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

        {isTauriRuntime() && (
          <Button variant="outline" size="sm" onClick={() => setCleanupOpen(true)}>
            <ShieldCheck className="w-4 h-4 mr-1.5" />
            {t("cleanupBeforeUninstall")}
          </Button>
        )}
      </div>

      {cleanupReport && (
        <div
          className="mt-2 space-y-2 border-t pt-3 text-[12px]"
          style={{ borderColor: "var(--app-border)" }}
          aria-live="polite"
        >
          <h4 className="text-[13px] font-medium" style={{ color: "var(--app-text-primary)" }}>
            {t("cleanupReport")}
          </h4>
          {(["cleaned", "skipped", "failed"] as const).map((kind) => (
            <div key={kind}>
              <div className="font-medium" style={{ color: "var(--app-text-secondary)" }}>
                {cleanupReportLabels[kind]} ({cleanupReport[kind].length})
              </div>
              {cleanupReport[kind].map((item) => (
                <div
                  key={`${kind}-${item}`}
                  className="break-all"
                  style={{ color: "var(--app-text-primary)" }}
                >
                  {item}
                </div>
              ))}
            </div>
          ))}
        </div>
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
            <Button disabled={cleaning} onClick={handleCleanup}>
              <ShieldCheck className="w-4 h-4 mr-1.5" />
              {cleaning ? t("cleaning") : t("cleanupNow")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
