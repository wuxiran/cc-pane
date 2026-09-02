// 价值卡「它能为你做什么」：条目按卖点重排（多 agent 并排第一、工作空间收束、
// 多 CLI 互通、数据留在本地——吸收原「多端支持」并按真实能力措辞）。
// 每卡顶部 64px 静态 SVG 图示条（主页不抢终端注意力，无动画），chart 四色做每卡 accent。
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Columns2, Folder, HardDrive, Workflow } from "lucide-react";

interface HomeDesignHighlightsProps {
  /** 紧凑横条模式（老用户页脚），默认卡片网格（新用户引导下方） */
  compact?: boolean;
}

interface Highlight {
  icon: ReactNode;
  titleKey: string;
  descKey: string;
  accentVar: string;
  viz: (accent: string) => ReactNode;
}

/** 双终端并排 */
function VizAgents(accent: string) {
  return (
    <>
      {[0, 1].map((column) => (
        <div key={column} className="flex w-[72px] flex-col gap-1.5 rounded-md border border-[var(--app-border)] bg-[var(--app-content)] p-2">
          {["70%", "50%", "62%"].map((width, index) => (
            <span key={index} className="block h-1 rounded-sm bg-[var(--app-hover)]" style={{ width }} />
          ))}
        </div>
      ))}
      <span className="absolute right-3.5 top-2.5 flex gap-1">
        <span className="size-[7px] rounded-full bg-[var(--app-status-success)]" />
        <span className="size-[7px] rounded-full" style={{ background: accent }} />
      </span>
    </>
  );
}

/** 三线收束进一个框 */
function VizGather(accent: string) {
  return (
    <svg width="110" height="44" viewBox="0 0 110 44" fill="none" aria-hidden="true">
      <path d="M8 8 C 34 8, 30 22, 55 22 M8 22 H 55 M8 36 C 34 36, 30 22, 55 22" stroke={accent} strokeWidth="1.5" opacity="0.55" />
      <circle cx="8" cy="8" r="3" fill={accent} opacity="0.7" />
      <circle cx="8" cy="22" r="3" fill={accent} opacity="0.7" />
      <circle cx="8" cy="36" r="3" fill={accent} opacity="0.7" />
      <rect x="55" y="12" width="44" height="20" rx="5" stroke={accent} strokeWidth="1.5" fill={`color-mix(in srgb, ${accent} 12%, transparent)`} />
    </svg>
  );
}

/** 双 CLI 身份色互指 */
function VizInterop(accent: string) {
  return (
    <>
      <span className="size-3.5 rounded-full bg-[var(--app-cli-claude)]" />
      <svg width="26" height="10" viewBox="0 0 26 10" fill="none" aria-hidden="true">
        <path d="M2 5h22M20 1l4 4-4 4M6 9 2 5l4-4" stroke={accent} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="size-3.5 rounded-full bg-[var(--app-cli-codex)]" />
    </>
  );
}

/** 本地磁盘 */
function VizLocal(accent: string) {
  return (
    <svg width="96" height="44" viewBox="0 0 96 44" fill="none" aria-hidden="true">
      <rect x="18" y="10" width="60" height="24" rx="5" stroke={accent} strokeWidth="1.5" fill={`color-mix(in srgb, ${accent} 8%, transparent)`} />
      <circle cx="30" cy="22" r="3.5" fill={accent} opacity="0.75" />
      <rect x="40" y="17" width="30" height="3.5" rx="2" fill={accent} opacity="0.4" />
      <rect x="40" y="24" width="22" height="3.5" rx="2" fill={accent} opacity="0.25" />
    </svg>
  );
}

const HIGHLIGHTS: Highlight[] = [
  {
    icon: <Columns2 className="h-4 w-4" />,
    titleKey: "highlights.agentsTitle",
    descKey: "highlights.agentsDesc",
    accentVar: "--chart-1",
    viz: VizAgents,
  },
  {
    icon: <Folder className="h-4 w-4" />,
    titleKey: "highlights.gatherTitle",
    descKey: "highlights.gatherDesc",
    accentVar: "--chart-3",
    viz: VizGather,
  },
  {
    icon: <Workflow className="h-4 w-4" />,
    titleKey: "highlights.multiCliTitle",
    descKey: "highlights.multiCliDesc",
    accentVar: "--chart-4",
    viz: VizInterop,
  },
  {
    icon: <HardDrive className="h-4 w-4" />,
    titleKey: "highlights.localFirstTitle",
    descKey: "highlights.localFirstDesc",
    accentVar: "--chart-2",
    viz: VizLocal,
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
            ? "grid grid-cols-1 gap-2 xl:gap-3 rounded-xl border border-[var(--app-home-border)] bg-[var(--app-home-surface)] p-3 xl:p-4 sm:grid-cols-2 xl:grid-cols-4"
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
                  ? "flex min-w-0 items-start gap-2.5 xl:gap-3 rounded-lg p-2 xl:p-3"
                  : "min-w-0 overflow-hidden rounded-xl border border-[var(--app-home-border)] bg-[var(--app-home-surface)]"
              }
            >
              {compact ? (
                <>
                  <span
                    className="mt-0.5 inline-flex h-7 w-7 xl:h-8 xl:w-8 shrink-0 items-center justify-center rounded-md"
                    style={{
                      background: `color-mix(in srgb, ${accent} 12%, transparent)`,
                      color: accent,
                    }}
                  >
                    {item.icon}
                  </span>
                  <div className="min-w-0">
                    <div
                      className="text-xs xl:text-sm font-semibold"
                      style={{ color: "var(--app-text-primary)" }}
                    >
                      {t(item.titleKey as never)}
                    </div>
                    <p
                      className="mt-0.5 text-[11px] xl:text-xs leading-snug"
                      style={{ color: "var(--app-text-tertiary)" }}
                    >
                      {t(item.descKey as never)}
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <div
                    aria-hidden="true"
                    className="relative flex h-16 items-center justify-center gap-2 border-b border-[var(--app-home-border)]"
                    style={{ background: `color-mix(in srgb, ${accent} 5%, transparent)` }}
                  >
                    {item.viz(accent)}
                  </div>
                  <div className="p-4">
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
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
