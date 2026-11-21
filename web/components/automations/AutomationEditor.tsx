import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { AcpEngineInfo } from "@/types";
import AutomationScopeFields from "@/components/settings/AutomationScopeFields";
import { weekdayLabels, type SchedulePreset } from "@/components/settings/automationsCron";
import type { EditorDraft } from "./automationDraft";

interface AutomationEditorProps {
  draft: EditorDraft;
  engines: readonly AcpEngineInfo[];
  saving: boolean;
  onChange: (next: EditorDraft) => void;
  onBrowseCwd: () => void;
  onCancel: () => void;
  onSave: () => void;
}

const PRESETS: SchedulePreset[] = ["hourly", "daily", "weekdays", "weekly", "custom"];
const SELECT_CLASS =
  "h-9 rounded-md border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-2.5 text-[length:var(--text-small)] text-[var(--app-text-primary)]";
const LABEL_CLASS = "text-[length:var(--text-small)] text-[var(--app-text-secondary)]";

/** 右栏编辑表单：Prompt 做成大输入框放最上，其次日程，再是运行位置与引擎，高级项收在最后。 */
export default function AutomationEditor({ draft, engines, saving, onChange, onBrowseCwd, onCancel, onSave }: AutomationEditorProps) {
  const { t, i18n } = useTranslation("settings");
  const autoApproveId = useId();
  const weekdays = weekdayLabels(i18n.language);
  const schedule = draft.schedule;
  const setSchedule = (next: Partial<EditorDraft["schedule"]>) => onChange({ ...draft, schedule: { ...schedule, ...next } });
  const canSave = !saving && draft.name.trim() !== "" && draft.prompt.trim() !== "" && draft.cwd.trim() !== "" && draft.engineId !== "";

  return (
    <form
      data-testid="automation-editor"
      className="flex h-full min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) onSave();
      }}
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-[var(--app-border)] py-4 pl-6 pr-14">
        <h2 className="min-w-0 flex-1 truncate text-[1.125rem] font-semibold text-[var(--app-text-primary)]">
          {draft.id ? t("automations.editTask") : t("automations.newTask")}
        </h2>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>{t("automations.cancel")}</Button>
        <Button type="submit" size="sm" disabled={!canSave}>{t("automations.save")}</Button>
      </header>

      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          <FormField label={t("automations.name")} className="flex flex-col gap-1.5" labelClassName={LABEL_CLASS}>
            {({ id }) => (
              <Input id={id} value={draft.name} autoFocus={!draft.id} onChange={(event) => onChange({ ...draft, name: event.target.value })} />
            )}
          </FormField>

          <FormField label={t("automations.prompt")} className="flex flex-col gap-1.5" labelClassName={LABEL_CLASS}>
            {({ id }) => (
              <textarea
                id={id}
                rows={6}
                placeholder={t("automations.promptPlaceholder")}
                className="min-h-[9rem] resize-y rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-4 py-3 text-[length:var(--text-body)] leading-6 text-[var(--app-text-primary)] outline-none placeholder:text-[var(--app-text-tertiary)] focus:border-[var(--app-accent)]"
                value={draft.prompt}
                onChange={(event) => onChange({ ...draft, prompt: event.target.value })}
              />
            )}
          </FormField>

          <div className="flex flex-wrap items-end gap-3">
            <FormField label={t("automations.schedule")} className="flex flex-col gap-1.5" labelClassName={LABEL_CLASS}>
              {({ id }) => (
                <select id={id} className={SELECT_CLASS} value={schedule.preset} onChange={(event) => setSchedule({ preset: event.target.value as SchedulePreset })}>
                  {PRESETS.map((preset) => (
                    <option key={preset} value={preset}>{t(`automations.preset.${preset}`)}</option>
                  ))}
                </select>
              )}
            </FormField>
            {schedule.preset === "weekly" && (
              <FormField label={t("automations.weekday")} className="flex flex-col gap-1.5" labelClassName={LABEL_CLASS}>
                {({ id }) => (
                  <select id={id} className={SELECT_CLASS} value={schedule.weekday} onChange={(event) => setSchedule({ weekday: Number(event.target.value) })}>
                    {weekdays.map((label, day) => (
                      <option key={day} value={day}>{label}</option>
                    ))}
                  </select>
                )}
              </FormField>
            )}
            {schedule.preset !== "hourly" && schedule.preset !== "custom" && (
              <FormField label={t("automations.time")} className="flex flex-col gap-1.5" labelClassName={LABEL_CLASS}>
                {({ id }) => (
                  <Input id={id} type="time" className="w-28" value={schedule.time} onChange={(event) => setSchedule({ time: event.target.value })} />
                )}
              </FormField>
            )}
            {schedule.preset === "custom" && (
              <FormField label={t("automations.cron")} className="flex flex-col gap-1.5" labelClassName={LABEL_CLASS}>
                {({ id }) => (
                  <Input id={id} className="w-44 font-mono" value={schedule.cron} onChange={(event) => setSchedule({ cron: event.target.value })} />
                )}
              </FormField>
            )}
            <FormField label={t("automations.engine")} className="flex flex-col gap-1.5" labelClassName={LABEL_CLASS}>
              {({ id }) => (
                <select id={id} className={SELECT_CLASS} value={draft.engineId} onChange={(event) => onChange({ ...draft, engineId: event.target.value })}>
                  {engines.map((engine) => (
                    <option key={engine.id} value={engine.id} disabled={!engine.available}>{engine.label}</option>
                  ))}
                </select>
              )}
            </FormField>
          </div>

          <AutomationScopeFields
            workspaceName={draft.workspaceName}
            cwd={draft.cwd}
            selectClass={SELECT_CLASS}
            onChange={(next) => onChange({ ...draft, ...next })}
            onBrowse={onBrowseCwd}
          />

          <fieldset className="flex flex-col gap-3 rounded-xl border border-[var(--app-border)] px-4 py-4">
            <legend className="px-1 text-[length:var(--text-small)] text-[var(--app-text-tertiary)]">{t("automations.advanced")}</legend>
            <FormField label={t("automations.timeoutMinutes")} className="flex items-center justify-between gap-3" labelClassName={LABEL_CLASS}>
              {({ id }) => (
                <Input id={id} type="number" min={1} className="w-24" value={draft.timeoutMinutes} onChange={(event) => onChange({ ...draft, timeoutMinutes: Number(event.target.value) || 30 })} />
              )}
            </FormField>
            <div className="flex items-start justify-between gap-3">
              <label htmlFor={autoApproveId} className="flex flex-col gap-0.5">
                <span className={LABEL_CLASS}>{t("automations.autoApprove")}</span>
                <span className="text-[length:var(--text-caption)] text-[var(--app-text-tertiary)]">{t("automations.autoApproveHint")}</span>
              </label>
              <Switch id={autoApproveId} checked={draft.autoApprove} onCheckedChange={(autoApprove) => onChange({ ...draft, autoApprove })} />
            </div>
          </fieldset>
        </div>
      </div>
    </form>
  );
}
