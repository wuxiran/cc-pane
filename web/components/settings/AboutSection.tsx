import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { useUpdateStore } from "@/stores";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";

export default function AboutSection() {
  const { t } = useTranslation("settings");
  const [version, setVersion] = useState("...");
  const [checking, setChecking] = useState(false);
  const updateAvailable = useUpdateStore((s) => s.available);
  const updateVersion = useUpdateStore((s) => s.version);

  useEffect(() => {
    getVersion().then(setVersion);
  }, []);

  const handleCheckUpdate = async () => {
    setChecking(true);
    try {
      // 动态 import 防止 updater 插件未注册时导致整个组件不渲染
      const { checkForAppUpdates } = await import("@/services/updaterService");
      await checkForAppUpdates(true);
    } catch (error) {
      console.error("[AboutSection] 检查更新失败:", error);
    } finally {
      setChecking(false);
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

      <Button
        variant="outline"
        size="sm"
        className="mt-2 self-start"
        disabled={checking}
        onClick={handleCheckUpdate}
      >
        <RefreshCw className={`w-4 h-4 mr-1.5 ${checking ? "animate-spin" : ""}`} />
        {checking ? t("checking") : t("checkUpdate")}
      </Button>
    </div>
  );
}
