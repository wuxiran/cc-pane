import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { checkForAppUpdates } from "@/services/updaterService";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";

export default function AboutSection() {
  const { t } = useTranslation("settings");
  const [version, setVersion] = useState("...");
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    getVersion().then(setVersion);
  }, []);

  const handleCheckUpdate = async () => {
    setChecking(true);
    try {
      await checkForAppUpdates(true);
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
