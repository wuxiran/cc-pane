// 空态页的任务模板：点一下即预填名称 / Prompt / 日程，用户再选目录与引擎后保存。
// 文案（标题、说明、Prompt）都在 i18n 的 automations.templates.<id> 下。
import type { ScheduleDraft } from "@/components/settings/automationsCron";

export interface AutomationTemplate {
  id: string;
  emoji: string;
  schedule: ScheduleDraft;
}

const daily = (time: string): ScheduleDraft => ({ preset: "daily", time, weekday: 1, cron: "" });
const weekdays = (time: string): ScheduleDraft => ({ preset: "weekdays", time, weekday: 1, cron: "" });
const weekly = (weekday: number, time: string): ScheduleDraft => ({ preset: "weekly", time, weekday, cron: "" });

export const AUTOMATION_TEMPLATES: readonly AutomationTemplate[] = [
  { id: "standup", emoji: "☕️", schedule: weekdays("09:00") },
  { id: "testPatrol", emoji: "🧪", schedule: daily("08:30") },
  { id: "dependencyAudit", emoji: "🛡️", schedule: weekly(1, "10:00") },
  { id: "weeklyReport", emoji: "📝", schedule: weekly(5, "17:30") },
  { id: "todoSweep", emoji: "📌", schedule: weekly(3, "16:00") },
  { id: "branchCleanup", emoji: "🌿", schedule: weekly(5, "18:00") },
  { id: "docsDrift", emoji: "📚", schedule: weekly(2, "11:00") },
  { id: "logTriage", emoji: "🚨", schedule: daily("07:30") },
];
