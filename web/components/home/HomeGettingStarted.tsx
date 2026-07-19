import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { FolderPlus, FolderSearch, Rocket, GraduationCap, ArrowRight } from "lucide-react";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { useDialogStore } from "@/stores";

interface HomeGettingStartedProps {
  onNewTerminal: () => void;
}

interface GuideStep {
  icon: ReactNode;
  titleKey: string;
  descKey: string;
  actionKey: string;
  accentVar: string;
  onClick: () => void;
}

/**
 * 新用户上手引导卡：占据用量趋势的位置，有数据后自然消失。
 * 创建工作空间 / 添加项目的对话框都在 explorer 侧栏内（sidebar 本地 state），
 * 因此前两步都引导到 explorer 侧栏入口。
 */
export default function HomeGettingStarted({ onNewTerminal }: HomeGettingStartedProps) {
  const { t } = useTranslation("home");
  const toggleView = useActivityBarStore((s) => s.toggleView);
  const openOnboarding = useDialogStore((s) => s.openOnboarding);

  // home 模式下 toggleView 会一次性切到 panes + 展开 explorer 侧栏
  const openExplorer = () => toggleView("explorer");

  const steps: GuideStep[] = [
    {
      icon: <FolderPlus className="w-5 h-5" />,
      titleKey: "guide.step1Title",
      descKey: "guide.step1Desc",
      actionKey: "guide.step1Action",
      accentVar: "--chart-1",
      onClick: openExplorer,
    },
    {
      icon: <FolderSearch className="w-5 h-5" />,
      titleKey: "guide.step2Title",
      descKey: "guide.step2Desc",
      actionKey: "guide.step2Action",
      accentVar: "--chart-4",
      onClick: openExplorer,
    },
    {
      icon: <Rocket className="w-5 h-5" />,
      titleKey: "guide.step3Title",
      descKey: "guide.step3Desc",
      actionKey: "guide.step3Action",
      accentVar: "--chart-2",
      onClick: onNewTerminal,
    },
  ];

  return (
    <section
      className="rounded-2xl border border-[var(--app-home-border)] bg-[var(--app-home-surface)] p-5"
      data-testid="getting-started"
    >
      <div className="mb-4">
        <h3
          className="text-base font-semibold"
          style={{ color: "var(--app-text-primary)" }}
        >
          {t("guide.title")}
        </h3>
        <p className="mt-0.5 text-xs" style={{ color: "var(--app-text-tertiary)" }}>
          {t("guide.subtitle")}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {steps.map((step, index) => {
          const accent = `var(${step.accentVar})`;
          return (
            <div
              key={step.titleKey}
              className="flex flex-col rounded-xl border p-4"
              style={{
                background: "var(--app-home-surface-light)",
                borderColor: "var(--app-home-border)",
              }}
            >
              <div className="flex items-center gap-2.5">
                <span
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                  style={{
                    background: `color-mix(in srgb, ${accent} 14%, transparent)`,
                    color: accent,
                  }}
                >
                  {step.icon}
                </span>
                <div className="min-w-0">
                  <div
                    className="text-[10px] font-medium uppercase tracking-wide"
                    style={{ color: "var(--app-text-tertiary)" }}
                  >
                    {t("guide.stepLabel", { num: index + 1 })}
                  </div>
                  <div
                    className="truncate text-sm font-semibold"
                    style={{ color: "var(--app-text-primary)" }}
                  >
                    {t(step.titleKey as never)}
                  </div>
                </div>
              </div>
              <p
                className="mt-2 flex-1 text-xs leading-relaxed"
                style={{ color: "var(--app-text-secondary)" }}
              >
                {t(step.descKey as never)}
              </p>
              <button
                className="mt-3 inline-flex h-8 items-center justify-center gap-1.5 self-start rounded-lg px-3 text-xs font-medium transition-opacity duration-[var(--dur-fast)] hover:opacity-80"
                style={{
                  background: `color-mix(in srgb, ${accent} 14%, transparent)`,
                  color: accent,
                }}
                onClick={step.onClick}
              >
                {t(step.actionKey as never)}
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>

      <button
        className="mt-4 inline-flex items-center gap-1.5 text-xs font-medium transition-opacity duration-[var(--dur-fast)] hover:opacity-80"
        style={{ color: "var(--app-accent)" }}
        onClick={openOnboarding}
      >
        <GraduationCap className="h-4 w-4" />
        {t("guide.fullTutorial")}
      </button>
    </section>
  );
}
