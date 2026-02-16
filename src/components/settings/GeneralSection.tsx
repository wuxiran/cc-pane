import { useState, useEffect } from "react";
import { toast } from "sonner";
import { open } from "@tauri-apps/plugin-dialog";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { settingsService } from "@/services";
import { useSettingsStore } from "@/stores";
import type { GeneralSettings, DataDirInfo } from "@/types";
import { formatSize } from "@/utils";

interface GeneralSectionProps {
  value: GeneralSettings;
  onChange: (value: GeneralSettings) => void;
}

export default function GeneralSection({ value, onChange }: GeneralSectionProps) {
  const [dataDirInfo, setDataDirInfo] = useState<DataDirInfo | null>(null);
  const [migrating, setMigrating] = useState(false);
  const loadSettings = useSettingsStore((s) => s.loadSettings);

  useEffect(() => {
    settingsService.getDataDirInfo().then(setDataDirInfo).catch(console.error);
  }, []);

  function update<K extends keyof GeneralSettings>(key: K, v: GeneralSettings[K]) {
    onChange({ ...value, [key]: v });
  }

  async function handleBrowse() {
    const selected = await open({ directory: true, multiple: false, title: "选择数据目录" });
    if (!selected || typeof selected !== "string") return;
    if (dataDirInfo && selected === dataDirInfo.currentPath) {
      toast.info("选择的目录与当前数据目录相同");
      return;
    }
    const confirmed = window.confirm(
      `将数据从\n${dataDirInfo?.currentPath}\n迁移到\n${selected}\n\n当前数据大小: ${dataDirInfo ? formatSize(dataDirInfo.sizeBytes) : "未知"}\n迁移完成后需要重启应用生效。\n\n确定开始迁移？`
    );
    if (!confirmed) return;
    setMigrating(true);
    try {
      await settingsService.migrateDataDir(selected);
      toast.success("迁移完成，请重启应用生效");
      const info = await settingsService.getDataDirInfo();
      setDataDirInfo(info);
      update("dataDir", selected);
      await loadSettings();
    } catch (e) {
      toast.error(`迁移失败: ${e}`);
    } finally {
      setMigrating(false);
    }
  }

  async function handleResetDataDir() {
    if (!dataDirInfo || dataDirInfo.isDefault) return;
    const confirmed = window.confirm(
      `将数据从\n${dataDirInfo.currentPath}\n迁移回默认位置\n${dataDirInfo.defaultPath}\n\n迁移完成后需要重启应用生效。\n\n确定开始迁移？`
    );
    if (!confirmed) return;
    setMigrating(true);
    try {
      await settingsService.migrateDataDir(dataDirInfo.defaultPath);
      toast.success("已恢复默认数据目录，请重启应用生效");
      const info = await settingsService.getDataDirInfo();
      setDataDirInfo(info);
      update("dataDir", null);
      await loadSettings();
    } catch (e) {
      toast.error(`恢复失败: ${e}`);
    } finally {
      setMigrating(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-[15px] font-semibold mb-1" style={{ color: "var(--app-text-primary)" }}>
        通用设置
      </h3>

      <div className="flex items-center justify-between">
        <Label>关闭窗口时最小化到托盘</Label>
        <input
          type="checkbox"
          checked={value.closeToTray}
          onChange={(e) => update("closeToTray", e.target.checked)}
          className="w-4 h-4 cursor-pointer"
          style={{ accentColor: "var(--app-accent)" }}
        />
      </div>

      <div className="flex items-center justify-between">
        <Label>开机自启</Label>
        <input
          type="checkbox"
          checked={value.autoStart}
          onChange={(e) => update("autoStart", e.target.checked)}
          className="w-4 h-4 cursor-pointer"
          style={{ accentColor: "var(--app-accent)" }}
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label>语言</Label>
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
          <option value="zh-CN">简体中文</option>
          <option value="en-US">English</option>
        </select>
      </div>

      {/* 数据目录 */}
      <div className="flex flex-col gap-1 mt-1 pt-3" style={{ borderTop: "1px solid var(--app-border)" }}>
        <Label>数据目录</Label>
        <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
          数据库、Provider 配置和工作空间的存储位置
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
            {dataDirInfo?.currentPath || "加载中..."}
          </span>
          <Button variant="secondary" size="sm" onClick={handleBrowse} disabled={migrating}>
            {migrating ? "迁移中..." : "浏览"}
          </Button>
        </div>
        {dataDirInfo && (
          <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
            数据大小: {formatSize(dataDirInfo.sizeBytes)}
            {!dataDirInfo.isDefault && (
              <>
                {" · "}
                <span
                  className="underline cursor-pointer"
                  style={{ color: "var(--app-accent)" }}
                  onClick={handleResetDataDir}
                >
                  恢复默认位置
                </span>
              </>
            )}
          </p>
        )}
        <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
          修改后需要重启应用生效
        </p>
      </div>
    </div>
  );
}
