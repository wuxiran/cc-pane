import { useTranslation } from "react-i18next";
import { Clock3, Loader2 } from "lucide-react";
import type { TodoActivity } from "@/types";

interface TodoActivityTimelineProps {
  activities: TodoActivity[];
  loading: boolean;
}

function formatTimestamp(value: string, locale: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export default function TodoActivityTimeline({ activities, loading }: TodoActivityTimelineProps) {
  const { t, i18n } = useTranslation("dialogs");

  return (
    <section className="min-w-0">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Clock3 size={13} />
        {t("todoActivity")}
      </div>
      {loading ? (
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Loader2 size={13} className="animate-spin" />
          {t("todoActivityLoading")}
        </div>
      ) : activities.length === 0 ? (
        <p className="py-1 text-xs text-muted-foreground">{t("todoActivityEmpty")}</p>
      ) : (
        <ol className="space-y-2 border-l border-border/60 pl-3">
          {activities.map((activity) => (
            <li key={activity.id} className="relative text-xs">
              <span className="absolute -left-[17px] top-1.5 h-1.5 w-1.5 rounded-full bg-muted-foreground/70" />
              <p className="text-foreground/85">
                {t(`todoActivity_${activity.action}`, { defaultValue: activity.action })}
                {activity.detail && <span className="text-muted-foreground">: {activity.detail}</span>}
              </p>
              <time className="text-[11px] text-muted-foreground">{formatTimestamp(activity.createdAt, i18n.language)}</time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
