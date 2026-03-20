import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Command, ArrowUpCircle, CheckCircle2 } from "lucide-react";
import { useUpdateStore } from "@/stores";
import { triggerUpdate } from "@/services";

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
    <div
      className="flex items-center gap-5 rounded-2xl p-6"
      style={{
        background: "var(--app-glass-bg)",
        border: "1px solid var(--app-glass-border)",
        boxShadow: "var(--app-glass-shadow)",
        backdropFilter: "blur(var(--app-glass-blur, 0px))",
      }}
    >
      {/* Logo 图标 */}
      <div
        className="w-14 h-14 rounded-2xl flex items-center justify-center shrink-0 relative"
        style={{
          background: "var(--app-accent)",
          boxShadow: "0 6px 20px color-mix(in srgb, var(--app-accent) 35%, transparent)",
        }}
      >
        <Command className="w-7 h-7 text-white" />
        {/* 光晕 */}
        <div
          className="absolute inset-0 rounded-2xl opacity-50"
          style={{
            background: "radial-gradient(circle at 30% 30%, rgba(255,255,255,0.2), transparent 60%)",
          }}
        />
      </div>

      {/* 文字区域 */}
      <div className="flex-1 min-w-0">
        <h1
          className="text-2xl font-bold"
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

      {/* 右侧：版本 + 更新状态 */}
      <div className="flex flex-col items-end gap-1 shrink-0">
        <span
          className="text-xs font-mono"
          style={{ color: "var(--app-text-tertiary)" }}
        >
          v{version}
        </span>
        {updateAvailable ? (
          <button
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium cursor-pointer transition-all duration-200 hover:opacity-80"
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
            style={{ color: "var(--app-text-tertiary)" }}
          >
            <CheckCircle2 className="w-3 h-3" />
            {t("upToDate")}
          </span>
        )}
      </div>
    </div>
  );
}
