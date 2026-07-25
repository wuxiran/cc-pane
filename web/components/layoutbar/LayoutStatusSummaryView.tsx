import { useTranslation } from "react-i18next";
import type { LayoutStatusSummary } from "./layoutStatusSummary";

// 摘要行：颜色圈 + 数量，零计数的桶直接隐藏；全零回退空闲文案。
// 色值复用 StatusIndicator 的状态色 token，保证与状态点语义一致。
const BUCKETS = [
  { key: "blocked", color: "var(--app-status-danger)", labelKey: "statusError" },
  { key: "waitingInput", color: "var(--app-status-warning)", labelKey: "statusWaitingInput" },
  { key: "running", color: "var(--app-accent)", labelKey: "statusActive" },
] as const;

export default function LayoutStatusSummaryView({
  summary,
  idleLabel,
}: {
  summary: LayoutStatusSummary;
  idleLabel: string;
}) {
  const { t } = useTranslation("dialogs");
  const visible = BUCKETS.filter((bucket) => summary[bucket.key] > 0);

  if (visible.length === 0) {
    return <span className="truncate">{idleLabel}</span>;
  }

  return (
    <span className="flex min-w-0 items-center gap-2 overflow-hidden">
      {visible.map((bucket) => (
        <span key={bucket.key} className="flex shrink-0 items-center gap-1" title={t(bucket.labelKey)}>
          <span
            aria-hidden
            className="inline-block h-[7px] w-[7px] shrink-0 rounded-full"
            style={{ backgroundColor: bucket.color }}
          />
          <span className="tabular-nums">{summary[bucket.key]}</span>
        </span>
      ))}
    </span>
  );
}
