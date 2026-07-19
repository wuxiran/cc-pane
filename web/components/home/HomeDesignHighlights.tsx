import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Layers, Workflow, Smartphone, HardDrive } from "lucide-react";

interface HomeDesignHighlightsProps {
  /** 紧凑横条模式（老用户页脚），默认卡片网格（新用户引导下方） */
  compact?: boolean;
}

interface Highlight {
  icon: ReactNode;
  titleKey: string;
  descKey: string;
  accentVar: string;
}

const HIGHLIGHTS: Highlight[] = [
  {
    icon: <Layers className="h-4 w-4" />,
    titleKey: "highlights.threeLayerTitle",
    descKey: "highlights.threeLayerDesc",
    accentVar: "--chart-1",
  },
  {
    icon: <Workflow className="h-4 w-4" />,
    titleKey: "highlights.multiCliTitle",
    descKey: "highlights.multiCliDesc",
    accentVar: "--chart-3",
  },
  {
    icon: <Smartphone className="h-4 w-4" />,
    titleKey: "highlights.multiDeviceTitle",
    descKey: "highlights.multiDeviceDesc",
    accentVar: "--chart-4",
  },
  {
    icon: <HardDrive className="h-4 w-4" />,
    titleKey: "highlights.localFirstTitle",
    descKey: "highlights.localFirstDesc",
    accentVar: "--chart-2",
  },
];

export default function HomeDesignHighlights({ compact = false }: HomeDesignHighlightsProps) {
  const { t } = useTranslation("home");

  return (
    <section data-testid="design-highlights">
      {!compact && (
        <h3
          className="mb-3 text-sm font-semibold"
          style={{ color: "var(--app-text-primary)" }}
        >
          {t("highlights.title")}
        </h3>
      )}
      <div
        className={
          compact
            ? "grid grid-cols-1 gap-2 rounded-xl border border-[var(--app-home-border)] bg-[var(--app-home-surface)] p-3 sm:grid-cols-2 xl:grid-cols-4"
            : "grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4"
        }
      >
        {HIGHLIGHTS.map((item) => {
          const accent = `var(${item.accentVar})`;
          return (
            <div
              key={item.titleKey}
              className={
                compact
                  ? "flex min-w-0 items-start gap-2.5 rounded-lg p-2"
                  : "min-w-0 rounded-xl border border-[var(--app-home-border)] bg-[var(--app-home-surface)] p-4"
              }
            >
              {compact ? (
                <>
                  <span
                    className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
                    style={{
                      background: `color-mix(in srgb, ${accent} 12%, transparent)`,
                      color: accent,
                    }}
                  >
                    {item.icon}
                  </span>
                  <div className="min-w-0">
                    <div
                      className="text-xs font-semibold"
                      style={{ color: "var(--app-text-primary)" }}
                    >
                      {t(item.titleKey as never)}
                    </div>
                    <p
                      className="mt-0.5 text-[11px] leading-snug"
                      style={{ color: "var(--app-text-tertiary)" }}
                    >
                      {t(item.descKey as never)}
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <span
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg"
                      style={{
                        background: `color-mix(in srgb, ${accent} 14%, transparent)`,
                        color: accent,
                      }}
                    >
                      {item.icon}
                    </span>
                    <span
                      className="truncate text-sm font-semibold"
                      style={{ color: "var(--app-text-primary)" }}
                    >
                      {t(item.titleKey as never)}
                    </span>
                  </div>
                  <p
                    className="mt-2 text-xs leading-relaxed"
                    style={{ color: "var(--app-text-secondary)" }}
                  >
                    {t(item.descKey as never)}
                  </p>
                </>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
