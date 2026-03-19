import { useState, useEffect } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { handleErrorSilent } from "@/utils";
import { open } from "@tauri-apps/plugin-dialog";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { settingsService } from "@/services";
import { useSettingsStore } from "@/stores";
import { useDialogStore } from "@/stores";
import { useCliTools } from "@/hooks/useCliTools";
import type { GeneralSettings, DataDirInfo, SearchScope } from "@/types";
import { formatSize } from "@/utils";

interface GeneralSectionProps {
  value: GeneralSettings;
  onChange: (value: GeneralSettings) => void;
}

export default function GeneralSection({ value, onChange }: GeneralSectionProps) {
  const { t, i18n } = useTranslation("settings");
  const [dataDirInfo, setDataDirInfo] = useState<DataDirInfo | null>(null);
  const [migrating, setMigrating] = useState(false);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const { tools: cliTools } = useCliTools();

  useEffect(() => {
    settingsService.getDataDirInfo().then(setDataDirInfo).catch((e) => handleErrorSilent(e, "get data dir info"));
  }, []);

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
      toast.info(t("dataDirSame"));
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
      toast.success(t("migrationDone"));
      const info = await settingsService.getDataDirInfo();
      setDataDirInfo(info);
      update("dataDir", selected);
      await loadSettings();
    } catch (e) {
      toast.error(t("migrationFailed", { error: e }));
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
      toast.success(t("dataDirResetDone"));
      const info = await settingsService.getDataDirInfo();
      setDataDirInfo(info);
      update("dataDir", null);
      await loadSettings();
    } catch (e) {
      toast.error(t("dataDirResetFailed", { error: e }));
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
        <Label>{t("closeToTray")}</Label>
        <input
          type="checkbox"
          checked={value.closeToTray}
          onChange={(e) => update("closeToTray", e.target.checked)}
          className="w-4 h-4 cursor-pointer"
          style={{ accentColor: "var(--app-accent)" }}
        />
      </div>

      <div className="flex items-center justify-between">
        <Label>{t("autoStart")}</Label>
        <input
          type="checkbox"
          checked={value.autoStart}
          onChange={(e) => update("autoStart", e.target.checked)}
          className="w-4 h-4 cursor-pointer"
          style={{ accentColor: "var(--app-accent)" }}
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label>{t("language")}</Label>
        <select
          value={value.language}
          onChange={(e) => update("language", e.target.value)}
          className="h-9 px-2 rounded-md text-[13px] outline-none w-40"
          style={{
            border: "1px solid var(--app-border)",
            background: "var(--app-content)",
            color: "var(--app-text-primary)",
          }}
        >
          <option value="zh-CN">{t("zhCN")}</option>
          <option value="en">{t("en")}</option>
        </select>
      </div>

      {/* 默认 CLI 工具 */}
      <div className="flex flex-col gap-1">
        <Label>{t("defaultCliTool")}</Label>
        <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
          {t("defaultCliToolDesc")}
        </p>
        <select
          value={value.defaultCliTool ?? "claude"}
          onChange={(e) => update("defaultCliTool", e.target.value)}
          className="h-9 px-2 rounded-md text-[13px] outline-none w-40"
          style={{
            border: "1px solid var(--app-border)",
            background: "var(--app-content)",
            color: "var(--app-text-primary)",
          }}
        >
          {cliTools.map((tool) => (
            <option key={tool.id} value={tool.id}>{tool.displayName}</option>
          ))}
        </select>
      </div>

      {/* 搜索范围 */}
      <div className="flex flex-col gap-1 mt-1 pt-3" style={{ borderTop: "1px solid var(--app-border)" }}>
        <Label>{t("searchScope")}</Label>
        <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
          {t("searchScopeDesc")}
        </p>
        <select
          value={value.searchScope}
          onChange={(e) => update("searchScope", e.target.value as SearchScope)}
          className="h-9 px-2 rounded-md text-[13px] outline-none w-40"
          style={{
            border: "1px solid var(--app-border)",
            background: "var(--app-content)",
            color: "var(--app-text-primary)",
          }}
        >
          <option value="Workspace">{t("searchScopeWorkspace")}</option>
          <option value="FullDisk">{t("searchScopeFullDisk")}</option>
        </select>
        {value.searchScope === "FullDisk" && (
          <p className="text-xs m-0" style={{ color: "var(--app-accent)" }}>
            {t("searchScopeFullDiskHint")}
          </p>
        )}
      </div>

      {/* 数据目录 */}
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
                <span
                  className="underline cursor-pointer"
                  style={{ color: "var(--app-accent)" }}
                  onClick={handleResetDataDir}
                >
                  {t("resetDataDir")}
                </span>
              </>
            )}
          </p>
        )}
        <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
          {t("dataDirRestartHint")}
        </p>
      </div>

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
