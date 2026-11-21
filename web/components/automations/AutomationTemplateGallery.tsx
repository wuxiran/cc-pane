import { useTranslation } from "react-i18next";
import { Clock } from "lucide-react";
import { AUTOMATION_TEMPLATES, type AutomationTemplate } from "./automationTemplates";

interface AutomationTemplateGalleryProps {
  onPick: (template: AutomationTemplate) => void;
}

/** 右栏空态：居中的「安排任务」标题 + 两列模板卡片，点卡片进入预填好的编辑表单。 */
export default function AutomationTemplateGallery({ onPick }: AutomationTemplateGalleryProps) {
  const { t } = useTranslation("settings");

  return (
    <div data-testid="automation-template-gallery" className="mx-auto flex w-full max-w-4xl flex-col items-center px-6 pb-10 pt-12">
      <div
        aria-hidden="true"
        className="flex size-16 items-center justify-center rounded-full border border-[var(--app-border)] bg-gradient-to-b from-[var(--app-panel-bg)] to-[var(--app-hover)] text-[var(--app-text-primary)] shadow-sm"
      >
        <Clock size={30} strokeWidth={1.75} />
      </div>
      <h2 className="mt-4 text-[1.375rem] font-semibold text-[var(--app-text-primary)]">{t("automations.heroTitle")}</h2>
      <p className="mt-1.5 text-center text-[length:var(--text-body)] text-[var(--app-text-secondary)]">
        {t("automations.heroDescription")}
      </p>
      <ul className="mt-10 grid w-full grid-cols-1 gap-4 md:grid-cols-2">
        {AUTOMATION_TEMPLATES.map((template) => (
          <li key={template.id}>
            <button
              type="button"
              data-template-id={template.id}
              onClick={() => onPick(template)}
              className="group flex h-full w-full items-center gap-4 rounded-2xl border border-dashed border-[var(--app-border)] px-5 py-5 text-left transition-colors hover:border-solid hover:border-[var(--app-border-strong,var(--app-border))] hover:bg-[var(--app-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
            >
              <span aria-hidden="true" className="shrink-0 text-[1.75rem] leading-none">{template.emoji}</span>
              <span className="flex min-w-0 flex-col gap-1">
                <span className="text-[length:var(--text-body)] font-medium text-[var(--app-text-primary)]">
                  {t(`automations.templates.${template.id}.title` as never)}
                </span>
                <span className="line-clamp-2 text-[length:var(--text-small)] leading-5 text-[var(--app-text-secondary)]">
                  {t(`automations.templates.${template.id}.description` as never)}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
