// 「哪些 CLI 能看见这个技能」的小圆点徽章，用 --app-cli-* 身份色。
import { useTranslation } from "react-i18next";
import { CONSUMER_TOKEN } from "./projectSkillModel";

interface ConsumerBadgesProps {
  consumers: readonly string[];
  compact?: boolean;
}

export default function ConsumerBadges({ consumers, compact = false }: ConsumerBadgesProps) {
  const { t } = useTranslation("projectSkills");
  if (consumers.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-1" aria-label={t("visibleTo")}>
      {consumers.map((id) => {
        const label = t(`consumer.${id}` as never, { defaultValue: id });
        const color = CONSUMER_TOKEN[id] ?? "var(--app-text-tertiary)";
        return compact ? (
          <span
            key={id}
            title={label}
            aria-label={label}
            className="size-2 rounded-full"
            style={{ background: color }}
          />
        ) : (
          <span
            key={id}
            className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px]"
            style={{
              background: `color-mix(in srgb, ${color} 14%, transparent)`,
              color,
            }}
          >
            <span className="size-1.5 rounded-full" style={{ background: color }} />
            {label}
          </span>
        );
      })}
    </span>
  );
}
