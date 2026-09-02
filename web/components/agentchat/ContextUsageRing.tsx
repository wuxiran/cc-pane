// 上下文窗口用量环（composer 右侧）：颜色按占用率分档，悬停给出精确 token
// 数与累计费用。引擎不上报 usage_update 时由调用方不渲染（诚实降级）。
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { AcpUsage } from "@/types/agentChat";

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return String(value);
}

export default function ContextUsageRing({ usage }: { usage: AcpUsage }) {
  const { t } = useTranslation("panes");
  const ratio = Math.min(1, usage.used / usage.size);
  const percent = Math.round(ratio * 100);
  // 满 90% 是危险（下一轮可能被压缩/截断），70% 起提醒。
  const tone =
    ratio >= 0.9
      ? "text-[var(--app-status-danger)]"
      : ratio >= 0.7
        ? "text-[var(--app-status-warning)]"
        : "text-[var(--app-accent)]";

  const cost =
    usage.cost && usage.cost.amount > 0
      ? `${usage.cost.amount.toFixed(usage.cost.amount < 1 ? 3 : 2)} ${usage.cost.currency}`
      : null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          role="img"
          aria-label={t("agentChatContextUsage", { percent })}
          className={`flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[11px] tabular-nums ${tone}`}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" className="-rotate-90 shrink-0">
            <circle
              cx="9"
              cy="9"
              r={RADIUS}
              fill="none"
              stroke="currentColor"
              strokeOpacity="0.2"
              strokeWidth="2"
            />
            <circle
              cx="9"
              cy="9"
              r={RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - ratio)}
              className="transition-[stroke-dashoffset] duration-[var(--dur-slow)] ease-[var(--ease-out)]"
            />
          </svg>
          <span>{percent}%</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        <div className="flex flex-col gap-0.5 tabular-nums">
          <span>
            {t("agentChatContextUsageDetail", {
              used: formatTokens(usage.used),
              size: formatTokens(usage.size),
            })}
          </span>
          {cost ? <span>{t("agentChatContextCost", { cost })}</span> : null}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
