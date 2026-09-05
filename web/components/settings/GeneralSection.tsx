import { useState, useEffect } from "react";
import { toastInfo, toastOk, toastErr } from "@/lib/feedback";
import { useTranslation } from "react-i18next";
import { handleErrorSilent, isTauriRuntime } from "@/utils";
import { open } from "@tauri-apps/plugin-dialog";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { settingsService } from "@/services";
import { useSettingsStore } from "@/stores";
import { useDialogStore } from "@/stores";
import { useCliTools } from "@/hooks/useCliTools";
import type { GeneralSettings, DataDirInfo, SearchScope } from "@/types";
import { formatSize } from "@/utils";

interface GeneralSectionProps {
  value: GeneralSettings;
  onChange: (value: GeneralSettings) => void;
  localHistoryEnabled?: boolean;
  onLocalHistoryEnabledChange?: (enabled: boolean) => void;
  updateNotifyEnabled?: boolean;
  onUpdateNotifyEnabledChange?: (enabled: boolean) => void;
  featureTipsEnabled?: boolean;
  onFeatureTipsEnabledChange?: (enabled: boolean) => void;
}

export default function GeneralSection({
  value,
  onChange,
  localHistoryEnabled = true,
  onLocalHistoryEnabledChange,
  updateNotifyEnabled = true,
  onUpdateNotifyEnabledChange,
  featureTipsEnabled = true,
  onFeatureTipsEnabledChange,
}: GeneralSectionProps) {
  const { t, i18n } = useTranslation("settings");
  const [dataDirInfo, setDataDirInfo] = useState<DataDirInfo | null>(null);
  const [migrating, setMigrating] = useState(false);
  const isDesktopRuntime = isTauriRuntime();
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const { tools: cliTools } = useCliTools();

  useEffect(() => {
    if (!isDesktopRuntime) return;
    settingsService.getDataDirInfo().then(setDataDirInfo).catch((e) => handleErrorSilent(e, "get data dir info"));
  }, [isDesktopRuntime]);

  function update<K extends keyof GeneralSettings>(key: K, v: GeneralSettings[K]) {
    if (key === "language") {
      i18n.changeLanguage(v as string);
    }
    onChange({ ...value, [key]: v });
  }

  async function handleBrowse() {
    const selected = await open({ directory: true, multiple: false, title: t("selectDataDir") });
    if (!selected || typeof selected !== "string") return;
    if (dataDirInfo && selected === dataDirInfo.currentPath) {
      toastInfo(t("dataDirSame"));
      return;
    }
    const confirmed = window.confirm(
      t("migrationConfirm", {
        from: dataDirInfo?.currentPath,
        to: selected,
        size: dataDirInfo ? formatSize(dataDirInfo.sizeBytes) : "—",
      })
    );
    if (!confirmed) return;
    setMigrating(true);
    try {
      await settingsService.migrateDataDir(selected);
      toastOk(t("migrationDone"));
      const info = await settingsService.getDataDirInfo();
      setDataDirInfo(info);
      update("dataDir", selected);
      await loadSettings();
    } catch (e) {
      toastErr(t("migrationFailed", { error: e }));
    } finally {
      setMigrating(false);
    }
  }

  async function handleResetDataDir() {
    if (!dataDirInfo || dataDirInfo.isDefault) return;
    const confirmed = window.confirm(
      t("resetMigrationConfirm", {
        from: dataDirInfo.currentPath,
        to: dataDirInfo.defaultPath,
      })
    );
    if (!confirmed) return;
    setMigrating(true);
    try {
      await settingsService.migrateDataDir(dataDirInfo.defaultPath);
      toastOk(t("dataDirResetDone"));
      const info = await settingsService.getDataDirInfo();
      setDataDirInfo(info);
      update("dataDir", null);
      await loadSettings();
    } catch (e) {
      toastErr(t("dataDirResetFailed", { error: e }));
    } finally {
      setMigrating(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-[15px] font-semibold mb-1" style={{ color: "var(--app-text-primary)" }}>
        {t("generalTitle")}
      </h3>

      <div className="flex items-center justify-between">
        <Label htmlFor="general-close-to-tray">{t("closeToTray")}</Label>
        <input
          id="general-close-to-tray"
          type="checkbox"
          checked={value.closeToTray}
          onChange={(e) => update("closeToTray", e.target.checked)}
          className="w-4 h-4 cursor-pointer"
          style={{ accentColor: "var(--app-accent)" }}
        />
      </div>

      <div className="flex items-center justify-between">
        <Label htmlFor="general-auto-start">{t("autoStart")}</Label>
        <input
          id="general-auto-start"
          type="checkbox"
          checked={value.autoStart}
          onChange={(e) => update("autoStart", e.target.checked)}
          className="w-4 h-4 cursor-pointer"
          style={{ accentColor: "var(--app-accent)" }}
        />
      </div>

      <div className="flex items-center justify-between">
        <Label htmlFor="general-show-system-resources">{t("showSystemResources")}</Label>
        <input
          id="general-show-system-resources"
          type="checkbox"
          aria-label={t("showSystemResources")}
          checked={value.showSystemResources ?? true}
          onChange={(e) => update("showSystemResources", e.target.checked)}
          className="w-4 h-4 cursor-pointer shrink-0"
          style={{ accentColor: "var(--app-accent)" }}
        />
      </div>

      <div className="flex items-center justify-between">
        <div className="flex flex-col pr-4">
          <Label htmlFor="general-update-notify-enabled">{t("updateNotifyEnabled")}</Label>
          <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
            {t("updateNotifyEnabledDesc")}
          </p>
        </div>
        <input
          id="general-update-notify-enabled"
          type="checkbox"
          aria-label={t("updateNotifyEnabled")}
          checked={updateNotifyEnabled}
          onChange={(event) => onUpdateNotifyEnabledChange?.(event.target.checked)}
          className="w-4 h-4 cursor-pointer shrink-0"
          style={{ accentColor: "var(--app-accent)" }}
        />
      </div>

      <div className="flex items-center justify-between">
        <div className="flex flex-col pr-4">
          <Label htmlFor="general-feature-tips-enabled">{t("featureTipsEnabled")}</Label>
          <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
            {t("featureTipsEnabledDesc")}
          </p>
        </div>
        <input
          id="general-feature-tips-enabled"
          type="checkbox"
          aria-label={t("featureTipsEnabled")}
          checked={featureTipsEnabled}
          onChange={(event) => onFeatureTipsEnabledChange?.(event.target.checked)}
          className="w-4 h-4 cursor-pointer shrink-0"
          style={{ accentColor: "var(--app-accent)" }}
        />
      </div>

      <div className="flex items-center justify-between">
        <div className="flex flex-col pr-4">
          <Label htmlFor="general-local-history-enabled">{t("localHistoryEnabled")}</Label>
          <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
            {t("localHistoryEnabledDesc")}
          </p>
        </div>
        <input
          id="general-local-history-enabled"
          type="checkbox"
          aria-label={t("localHistoryEnabled")}
          checked={localHistoryEnabled}
          onChange={(event) => onLocalHistoryEnabledChange?.(event.target.checked)}
          className="w-4 h-4 cursor-pointer shrink-0"
          style={{ accentColor: "var(--app-accent)" }}
        />
      </div>

      <div className="flex items-center justify-between">
        <div className="flex flex-col">
          <Label htmlFor="general-disable-wsl-usage-scan">{t("disableWslUsageScan")}</Label>
          <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
            {t("disableWslUsageScanDesc")}
          </p>
        </div>
        <input
          id="general-disable-wsl-usage-scan"
          type="checkbox"
          checked={value.disableWslUsageScan ?? false}
          onChange={(e) => update("disableWslUsageScan", e.target.checked)}
          className="w-4 h-4 cursor-pointer shrink-0"
          style={{ accentColor: "var(--app-accent)" }}
        />
      </div>

      <div className="flex items-center justify-between gap-6">
        <Label htmlFor="general-language">{t("language")}</Label>
        <Select value={value.language} onValueChange={(next) => update("language", next)}>
          <SelectTrigger id="general-language" aria-label={t("language")} className="w-44 shrink-0 bg-[var(--app-content)] text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="zh-CN">{t("zhCN")}</SelectItem>
            <SelectItem value="en">{t("en")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* 默认 CLI 工具 */}
      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0">
          <Label htmlFor="general-default-cli-tool">{t("defaultCliTool")}</Label>
          <p className="m-0 text-xs" style={{ color: "var(--app-text-tertiary)" }}>
            {t("defaultCliToolDesc")}
          </p>
        </div>
        <Select value={value.defaultCliTool ?? "claude"} onValueChange={(next) => update("defaultCliTool", next)}>
          <SelectTrigger id="general-default-cli-tool" aria-label={t("defaultCliTool")} className="w-44 shrink-0 bg-[var(--app-content)] text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {cliTools.map((tool) => (
              <SelectItem key={tool.id} value={tool.id}>{tool.displayName}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* 搜索范围 */}
      <div className="mt-1 border-t pt-3" style={{ borderColor: "var(--app-border)" }}>
        <div className="flex items-center justify-between gap-6">
          <div className="min-w-0">
            <Label htmlFor="general-search-scope">{t("searchScope")}</Label>
            <p className="m-0 text-xs" style={{ color: "var(--app-text-tertiary)" }}>
              {t("searchScopeDesc")}
            </p>
          </div>
          <Select value={value.searchScope} onValueChange={(next) => update("searchScope", next as SearchScope)}>
            <SelectTrigger id="general-search-scope" aria-label={t("searchScope")} className="w-44 shrink-0 bg-[var(--app-content)] text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="Workspace">{t("searchScopeWorkspace")}</SelectItem>
              <SelectItem value="FullDisk">{t("searchScopeFullDisk")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {value.searchScope === "FullDisk" && (
          <p className="mt-2 text-xs" style={{ color: "var(--app-accent)" }}>
            {t("searchScopeFullDiskHint")}
          </p>
        )}
      </div>

      {/* 数据目录 */}
      {isDesktopRuntime && (
      <div className="flex flex-col gap-1 mt-1 pt-3" style={{ borderTop: "1px solid var(--app-border)" }}>
        <Label>{t("dataDir")}</Label>
        <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
          {t("dataDirDesc")}
        </p>
        <div className="flex items-center gap-2">
          <span
            className="flex-1 text-[13px] px-2.5 py-1.5 rounded-md overflow-hidden text-ellipsis whitespace-nowrap font-mono"
            style={{
              color: "var(--app-text-secondary)",
              background: "var(--app-hover)",
              border: "1px solid var(--app-border)",
            }}
            title={dataDirInfo?.currentPath}
          >
            {dataDirInfo?.currentPath || t("loading", { ns: "common" })}
          </span>
          <Button variant="secondary" size="sm" onClick={handleBrowse} disabled={migrating}>
            {migrating ? t("migrating") : t("browse", { ns: "common" })}
          </Button>
        </div>
        {dataDirInfo && (
          <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
            {t("dataSize", { size: formatSize(dataDirInfo.sizeBytes) })}
            {!dataDirInfo.isDefault && (
              <>
                {" · "}
                <button
                  type="button"
                  className="underline cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
                  style={{ color: "var(--app-accent)" }}
                  onClick={handleResetDataDir}
                >
                  {t("resetDataDir")}
                </button>
              </>
            )}
          </p>
        )}
        <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
          {t("dataDirRestartHint")}
        </p>
      </div>
      )}

      {/* 新手引导 */}
      <div className="flex flex-col gap-1 mt-1 pt-3" style={{ borderTop: "1px solid var(--app-border)" }}>
        <Label>{t("restartOnboarding", { ns: "onboarding" })}</Label>
        <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
          {t("restartOnboardingDesc", { ns: "onboarding" })}
        </p>
        <Button
          variant="secondary"
          size="sm"
          className="w-fit mt-1"
          onClick={() => {
            onChange({ ...value, onboardingCompleted: false });
            useDialogStore.getState().openOnboarding();
          }}
        >
          {t("restartOnboarding", { ns: "onboarding" })}
        </Button>
      </div>
    </div>
  );
}
