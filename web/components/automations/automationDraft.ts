// 定时任务编辑草稿 ↔ AutomationDef 互转，以及列表/详情用的日程与时间文案。
import type { TFunction } from "i18next";
import type { AutomationDef } from "@/types";
import { buildCron, parseCron, weekdayLabels, type ScheduleDraft } from "@/components/settings/automationsCron";

export interface EditorDraft {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  workspaceName: string;
  engineId: string;
  schedule: ScheduleDraft;
  enabled: boolean;
  graceMinutes: number;
  timeoutMinutes: number;
  autoApprove: boolean;
}

export function emptyDraft(defaultEngineId: string, workspaceName = "", cwd = ""): EditorDraft {
  return {
    id: "",
    name: "",
    prompt: "",
    cwd,
    workspaceName,
    engineId: defaultEngineId,
    schedule: { preset: "daily", time: "09:00", weekday: 1, cron: "0 9 * * *" },
    enabled: true,
    graceMinutes: 10,
    timeoutMinutes: 30,
    autoApprove: true,
  };
}

export function toDraft(def: AutomationDef, inferredWorkspace: string): EditorDraft {
  return {
    id: def.id,
    name: def.name,
    prompt: def.prompt,
    cwd: def.cwd,
    workspaceName: def.workspaceName ?? inferredWorkspace,
    engineId: def.engineId,
    schedule: parseCron(def.schedule),
    enabled: def.enabled,
    graceMinutes: def.graceMinutes,
    timeoutMinutes: def.timeoutMinutes,
    autoApprove: def.autoApprove,
  };
}

export function toDef(draft: EditorDraft): AutomationDef {
  return {
    id: draft.id,
    name: draft.name.trim(),
    prompt: draft.prompt,
    cwd: draft.cwd,
    workspaceName: draft.workspaceName || null,
    engineId: draft.engineId,
    schedule: buildCron(draft.schedule),
    enabled: draft.enabled,
    graceMinutes: draft.graceMinutes,
    timeoutMinutes: draft.timeoutMinutes,
    autoApprove: draft.autoApprove,
    createdAt: 0,
    updatedAt: 0,
    nextRunAt: null,
  };
}

/** 「每天 09:00」「每周一 09:00」这类人话日程；对不上预设的显示原始 cron。 */
export function describeSchedule(schedule: string, t: TFunction<"settings">, locale: string): string {
  const parsed = parseCron(schedule);
  switch (parsed.preset) {
    case "hourly":
      return t("automations.preset.hourly");
    case "daily":
    case "weekdays":
      return `${t(`automations.preset.${parsed.preset}`)} ${parsed.time}`;
    case "weekly":
      return t("automations.everyWeekday", { day: weekdayLabels(locale)[parsed.weekday], time: parsed.time });
    case "custom":
      return parsed.cron;
  }
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** 下次运行：今天/明天 HH:MM，更远显示日期。 */
export function describeNextRun(
  millis: number | null | undefined,
  t: TFunction<"settings">,
  locale: string,
  now: Date = new Date(),
): string {
  if (!millis) return "—";
  const target = new Date(millis);
  const time = target.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const dayDiff = Math.round((startOfDay(target) - startOfDay(now)) / 86_400_000);
  if (dayDiff === 0) return t("automations.todayAt", { time });
  if (dayDiff === 1) return t("automations.tomorrowAt", { time });
  return target.toLocaleString(locale, { month: "short", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
}

export function formatMillis(millis: number | null | undefined, locale: string): string {
  if (!millis) return "—";
  return new Date(millis).toLocaleString(locale);
}
