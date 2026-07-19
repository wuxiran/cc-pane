// 场景模板 chips：默认 / 编程 / 文档 / 架构。点击 = applyScenario 一次性覆写
// draft 的 appendSystemPrompt/effort/verbose（+模板自带 chips），之后手改不回弹。
import { useTranslation } from "react-i18next";
import { applyScenario, LAUNCHER_SCENARIOS } from "@/constants/launcherScenarios";
import type { LauncherDraft } from "./launcherModel";

interface LauncherScenarioRowProps {
  draft: LauncherDraft;
  onChange: (patch: Partial<LauncherDraft>) => void;
}

export default function LauncherScenarioRow({ draft, onChange }: LauncherScenarioRowProps) {
  const { t } = useTranslation("launcher");

  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      role="radiogroup"
      aria-label={t("sectionScenario")}
      title={t("scenarioHint")}
    >
      {LAUNCHER_SCENARIOS.map((scenario) => {
        const active = draft.scenarioId === scenario.id;
        return (
          <button
            key={scenario.id}
            type="button"
            role="radio"
            aria-checked={active}
            className="rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)]"
            style={
              active
                ? {
                    borderColor: "var(--app-accent)",
                    background: "color-mix(in srgb, var(--app-accent) 12%, transparent)",
                    color: "var(--app-accent)",
                  }
                : { borderColor: "var(--app-border)", color: "var(--app-text-secondary)" }
            }
            onClick={() => onChange(applyScenario(scenario))}
          >
            {/* i18nKey 恒等于 `scenario.<id>`；用 id 模板字面量满足 i18n 键的严格类型 */}
            {t(`scenario.${scenario.id}`)}
          </button>
        );
      })}
    </div>
  );
}
