import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpCircle, CheckCircle2 } from "lucide-react";
import { useUpdateStore } from "@/stores";
import { triggerUpdate } from "@/services";
import logoUrl from "@/assets/logo.svg";

interface HomeHeaderProps {
  version: string;
}

function getGreetingKey(): "goodMorning" | "goodAfternoon" | "goodEvening" {
  const hour = new Date().getHours();
  if (hour < 12) return "goodMorning";
  if (hour < 18) return "goodAfternoon";
  return "goodEvening";
}

export default function HomeHeader({ version }: HomeHeaderProps) {
  const { t } = useTranslation("home");
  const updateAvailable = useUpdateStore((s) => s.available);
  const updateVersion = useUpdateStore((s) => s.version);
  const greetingKey = useMemo(getGreetingKey, []);

  return (
    <div className="flex items-center justify-between gap-5 px-1">
      <div className="flex items-center gap-5 min-w-0">
        {/* Logo 图标 */}
        <img
          src={logoUrl}
          alt="CC-Panes"
          className="w-16 h-16 rounded-2xl shrink-0 shadow-lg"
          style={{ boxShadow: "0 10px 28px color-mix(in srgb, var(--app-accent) 20%, transparent)" }}
          draggable={false}
        />

        {/* 文字区域 */}
        <div className="min-w-0">
          <h1
            className="text-2xl font-bold tracking-wide"
            style={{ color: "var(--app-text-primary)" }}
          >
            {t(greetingKey)}
          </h1>
          <p
            className="text-sm mt-0.5"
            style={{ color: "var(--app-text-secondary)" }}
          >
            {t("welcomeBack")} — CC-Panes
          </p>
        </div>
      </div>

      {/* 右侧：版本 + 更新状态 */}
      <div className="flex flex-col items-end gap-1 shrink-0">
        <span
          className="text-xs font-mono px-2.5 py-1 rounded-full border"
          style={{
            background: "color-mix(in srgb, var(--chart-2) 10%, transparent)",
            borderColor: "color-mix(in srgb, var(--chart-2) 20%, transparent)",
            color: "var(--chart-2)",
          }}
        >
          v{version}
        </span>
        {updateAvailable ? (
          <button
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium cursor-pointer transition-opacity duration-[var(--dur-fast)] hover:opacity-80"
            style={{
              background: "color-mix(in srgb, var(--app-accent) 15%, transparent)",
              color: "var(--app-accent)",
              animation: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
            }}
            onClick={() => triggerUpdate()}
          >
            <ArrowUpCircle className="w-3.5 h-3.5" />
            {t("updateAvailable")} {updateVersion}
          </button>
        ) : (
          <span
            className="inline-flex items-center gap-1 text-xs"
            style={{ color: "var(--chart-2)" }}
          >
            <CheckCircle2 className="w-3 h-3" />
            {t("upToDate")}
          </span>
        )}
      </div>
    </div>
  );
}
