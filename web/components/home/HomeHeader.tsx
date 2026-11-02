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
    <div className="flex items-center justify-between gap-4 px-1">
      <div className="flex items-center gap-3 min-w-0">
        <img
          src={logoUrl}
          alt="CC-Panes"
          className="size-9 rounded-lg shrink-0"
          draggable={false}
        />
        <h1
          className="text-[length:var(--text-display)] font-semibold tracking-tight"
          style={{ color: "var(--app-text-primary)" }}
        >
          {t(greetingKey)}
        </h1>
      </div>

      {/* 右侧：版本 + 更新状态 */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-xs tabular-nums" style={{ color: "var(--app-text-tertiary)" }}>
          v{version}
        </span>
        {updateAvailable ? (
          <button
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium cursor-default transition-opacity duration-[var(--dur-fast)] hover:opacity-80"
            style={{
              background: "color-mix(in srgb, var(--app-accent) 15%, transparent)",
              color: "var(--app-accent)",
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
