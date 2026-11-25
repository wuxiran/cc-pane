import DefaultWorkspaceDirSetting from "./DefaultWorkspaceDirSetting";
import { isSettingsWindow, sendActionToMainWindow } from "@/services/settingsWindowService";
import { useState, useEffect } from "react";
import { toastInfo, toastOk, toastErr } from "@/lib/feedback";
import { useTranslation } from "react-i18next";
import { handleErrorSilent, isTauriRuntime } from "@/utils";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import {
  TRAY_MAX_PENDING_ENTRIES_DEFAULT,
  TRAY_MAX_PENDING_ENTRIES_MAX,
  TRAY_MAX_PENDING_ENTRIES_MIN,
} from "@/stores/useSettingsStore";
import { useCliTools } from "@/hooks/useCliTools";
import type { GeneralSettings, DataDirInfo, SearchScope } from "@/types";
import { formatSize } from "@/utils";
import {
  SettingsHint,
  SettingsRow,
  SettingsSection,
  SettingsSwitchRow,
  SettingsValue,
} from "./layout";
import { nativeConfirm } from "@/services/nativeDialog";

// 托盘「待处理会话最多显示条数」的可选域（1-10）。
const TRAY_MAX_PENDING_OPTIONS = Array.from(
  { length: TRAY_MAX_PENDING_ENTRIES_MAX - TRAY_MAX_PENDING_ENTRIES_MIN + 1 },
  (_, index) => TRAY_MAX_PENDING_ENTRIES_MIN + index,
);

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
    const confirmed = await nativeConfirm(
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
    const confirmed = await nativeConfirm(
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

  const selectTriggerClass = "w-44 shrink-0 bg-[var(--app-content)] text-[length:var(--text-row)]";

  return (
    <>
      <SettingsSection sectionId="general-basics">
        <SettingsRow
          title={t("language")}
          htmlFor="general-language"
          control={(
            <Select value={value.language} onValueChange={(next) => update("language", next)}>
              <SelectTrigger id="general-language" aria-label={t("language")} className={selectTriggerClass}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="zh-CN">{t("zhCN")}</SelectItem>
                <SelectItem value="en">{t("en")}</SelectItem>
              </SelectContent>
            </Select>
          )}
        />
        <SettingsRow
          title={t("defaultCliTool")}
          description={t("defaultCliToolDesc")}
          htmlFor="general-default-cli-tool"
          control={(
            <Select value={value.defaultCliTool ?? "claude"} onValueChange={(next) => update("defaultCliTool", next)}>
              <SelectTrigger id="general-default-cli-tool" aria-label={t("defaultCliTool")} className={selectTriggerClass}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {cliTools.map((tool) => (
                  <SelectItem key={tool.id} value={tool.id}>{tool.displayName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
        <SettingsSwitchRow
          id="general-auto-start"
          title={t("autoStart")}
          checked={value.autoStart}
          onCheckedChange={(checked) => update("autoStart", checked)}
        />
        <SettingsSwitchRow
          id="general-close-to-tray"
          title={t("closeToTray")}
          checked={value.closeToTray}
          onCheckedChange={(checked) => update("closeToTray", checked)}
        />
        <SettingsSwitchRow
          id="general-show-system-resources"
          title={t("showSystemResources")}
          checked={value.showSystemResources ?? true}
          onCheckedChange={(checked) => update("showSystemResources", checked)}
        />
        <SettingsSwitchRow
          id="general-update-notify-enabled"
          title={t("updateNotifyEnabled")}
          description={t("updateNotifyEnabledDesc")}
          checked={updateNotifyEnabled}
          onCheckedChange={(checked) => onUpdateNotifyEnabledChange?.(checked)}
        />
        <SettingsSwitchRow
          id="general-feature-tips-enabled"
          title={t("featureTipsEnabled")}
          description={t("featureTipsEnabledDesc")}
          checked={featureTipsEnabled}
          onCheckedChange={(checked) => onFeatureTipsEnabledChange?.(checked)}
        />
      </SettingsSection>

      {/* 系统托盘：general-tray 供托盘「打开设置」滚动定位 */}
      <SettingsSection title={t("traySectionTitle")} sectionId="general-tray">
        <SettingsSwitchRow
          id="general-tray-show-session-status"
          title={t("trayShowSessionStatus")}
          description={t("trayShowSessionStatusDesc")}
          checked={value.trayShowSessionStatus ?? true}
          onCheckedChange={(checked) => update("trayShowSessionStatus", checked)}
        />
        <SettingsRow
          title={t("trayMaxPendingEntries")}
          description={t("trayMaxPendingEntriesDesc")}
          htmlFor="general-tray-max-pending"
          control={(
            <Select
              value={String(value.trayMaxPendingEntries ?? TRAY_MAX_PENDING_ENTRIES_DEFAULT)}
              onValueChange={(next) => update("trayMaxPendingEntries", Number(next))}
            >
              <SelectTrigger
                id="general-tray-max-pending"
                aria-label={t("trayMaxPendingEntries")}
                className={selectTriggerClass}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRAY_MAX_PENDING_OPTIONS.map((count) => (
                  <SelectItem key={count} value={String(count)}>
                    {count}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
        <SettingsSwitchRow
          id="general-tray-tooltip-summary"
          title={t("trayTooltipSummary")}
          description={t("trayTooltipSummaryDesc")}
          checked={value.trayTooltipSummary ?? true}
          onCheckedChange={(checked) => update("trayTooltipSummary", checked)}
        />
        <SettingsSwitchRow
          id="general-tray-confirm-quit"
          title={t("trayConfirmQuit")}
          description={t("trayConfirmQuitDesc")}
          checked={value.trayConfirmQuit ?? true}
          onCheckedChange={(checked) => update("trayConfirmQuit", checked)}
        />
      </SettingsSection>

      <SettingsSection title={t("generalGroups.files")} sectionId="general-files">
        <SettingsSwitchRow
          id="general-local-history-enabled"
          title={t("localHistoryEnabled")}
          description={t("localHistoryEnabledDesc")}
          checked={localHistoryEnabled}
          onCheckedChange={(checked) => onLocalHistoryEnabledChange?.(checked)}
        />
        <SettingsRow
          title={t("searchScope")}
          description={t("searchScopeDesc")}
          htmlFor="general-search-scope"
          control={(
            <Select value={value.searchScope} onValueChange={(next) => update("searchScope", next as SearchScope)}>
              <SelectTrigger id="general-search-scope" aria-label={t("searchScope")} className={selectTriggerClass}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Workspace">{t("searchScopeWorkspace")}</SelectItem>
                <SelectItem value="FullDisk">{t("searchScopeFullDisk")}</SelectItem>
              </SelectContent>
            </Select>
          )}
        >
          {value.searchScope === "FullDisk" && (
            <p className="m-0 text-[length:var(--text-small)]" style={{ color: "var(--app-accent)" }}>
              {t("searchScopeFullDiskHint")}
            </p>
          )}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title={t("generalGroups.data")} sectionId="general-data">
        {isDesktopRuntime && (
          <SettingsRow
            title={t("dataDir")}
            description={t("dataDirDesc")}
            control={(
              <Button variant="secondary" size="sm" onClick={handleBrowse} disabled={migrating}>
                {migrating ? t("migrating") : t("browse", { ns: "common" })}
              </Button>
            )}
          >
            <SettingsValue title={dataDirInfo?.currentPath}>
              {dataDirInfo?.currentPath || t("loading", { ns: "common" })}
            </SettingsValue>
            <SettingsHint>
              {dataDirInfo && t("dataSize", { size: formatSize(dataDirInfo.sizeBytes) })}
              {dataDirInfo && !dataDirInfo.isDefault && (
                <>
                  {" · "}
                  <button
                    type="button"
                    className="underline cursor-default rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
                    style={{ color: "var(--app-accent)" }}
                    onClick={handleResetDataDir}
                  >
                    {t("resetDataDir")}
                  </button>
                </>
              )}
              {dataDirInfo && " · "}
              {t("dataDirRestartHint")}
            </SettingsHint>
          </SettingsRow>
        )}
        {isDesktopRuntime && <DefaultWorkspaceDirSetting />}
        {/* 记忆库路径：允许 dev / release 共用一份记忆 */}
        <SettingsRow
          title={t("memoryDbPath")}
          description={`${t("memoryDbPathDesc")} ${t("dataDirRestartHint")}`}
          htmlFor="general-memory-db-path"
        >
          <Input
            id="general-memory-db-path"
            value={value.memoryDbPath ?? ""}
            onChange={(e) => update("memoryDbPath", e.target.value.trim() ? e.target.value : null)}
            placeholder={t("memoryDbPathPlaceholder")}
            className="h-8 font-mono text-xs"
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title={t("advancedSettings")} sectionId="general-advanced">
        <SettingsSwitchRow
          id="general-disable-wsl-usage-scan"
          title={t("disableWslUsageScan")}
          description={t("disableWslUsageScanDesc")}
          checked={value.disableWslUsageScan ?? false}
          onCheckedChange={(checked) => update("disableWslUsageScan", checked)}
        />
        <SettingsRow
          title={t("restartOnboarding", { ns: "onboarding" })}
          description={t("restartOnboardingDesc", { ns: "onboarding" })}
          control={(
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                onChange({ ...value, onboardingCompleted: false });
                if (isSettingsWindow()) void sendActionToMainWindow({ type: "openOnboarding" });
                else useDialogStore.getState().openOnboarding();
              }}
            >
              {t("restartOnboarding", { ns: "onboarding" })}
            </Button>
          )}
        />
      </SettingsSection>
    </>
  );
}
