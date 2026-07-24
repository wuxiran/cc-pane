import { FlaskConical } from "lucide-react";
import { useTranslation } from "react-i18next";

export default function ExperimentalSection() {
  const { t } = useTranslation("settings");

  return (
    <div className="flex min-h-56 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-[var(--app-border)] bg-[var(--app-panel-bg)] px-8 py-10 text-center">
      <span className="flex size-10 items-center justify-center rounded-lg bg-[var(--app-active-bg)] text-[var(--app-accent)]">
        <FlaskConical aria-hidden="true" size={20} />
      </span>
      <div className="space-y-1">
        <h2 className="text-[14px] font-medium text-[var(--app-text-primary)]">{t("experimental.emptyTitle")}</h2>
        <p className="max-w-md text-[12px] text-[var(--app-text-tertiary)]">{t("experimental.emptyDescription")}</p>
      </div>
    </div>
  );
}
