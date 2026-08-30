/** Automations 设置节的 cron 预设 ↔ 5 字段表达式互转。 */

export type SchedulePreset = "hourly" | "daily" | "weekdays" | "weekly" | "custom";

export interface ScheduleDraft {
  preset: SchedulePreset;
  /** HH:MM（daily / weekdays / weekly 用） */
  time: string;
  /** 0-6，周日=0（weekly 用） */
  weekday: number;
  /** custom 时的原始 5 字段 cron */
  cron: string;
}

export function buildCron(draft: ScheduleDraft): string {
  const [hourRaw, minuteRaw] = draft.time.split(":");
  const hour = clampInt(hourRaw, 0, 23, 9);
  const minute = clampInt(minuteRaw, 0, 59, 0);
  switch (draft.preset) {
    case "hourly":
      return "0 * * * *";
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly":
      return `${minute} ${hour} * * ${draft.weekday}`;
    case "custom":
      return draft.cron.trim();
  }
}

/** 已保存的 cron 反推预设；对不上的一律归 custom。 */
export function parseCron(schedule: string): ScheduleDraft {
  const cron = schedule.trim();
  const fallback: ScheduleDraft = { preset: "custom", time: "09:00", weekday: 1, cron };
  if (cron === "0 * * * *") {
    return { preset: "hourly", time: "09:00", weekday: 1, cron };
  }
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6])$/.exec(cron);
  if (!match) return fallback;
  const time = `${match[2].padStart(2, "0")}:${match[1].padStart(2, "0")}`;
  if (match[3] === "*") return { preset: "daily", time, weekday: 1, cron };
  if (match[3] === "1-5") return { preset: "weekdays", time, weekday: 1, cron };
  return { preset: "weekly", time, weekday: Number(match[3]), cron };
}

export function weekdayLabels(locale: string): string[] {
  const formatter = new Intl.DateTimeFormat(locale, { weekday: "short" });
  // 2023-01-01 是周日，连排 7 天拿本地化短名（索引 0 = 周日，对齐 cron）。
  return Array.from({ length: 7 }, (_, day) =>
    formatter.format(new Date(Date.UTC(2023, 0, 1 + day, 12))),
  );
}

function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  if (Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
