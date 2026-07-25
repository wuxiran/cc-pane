import { useTranslation } from "react-i18next";
import type { LayoutStatusSummary } from "./layoutStatusSummary";

// 2×2 固定槽位状态块：上行=急事(红 出错|琥珀 等授权)，下行=缓事(accent 运行中|灰 空闲)。
// 槽位全局一致便于扫读；零的格留白但占位，无会话时整块收起（由调用方显示文字）。
const CELLS = [
  { key: "blocked", color: "var(--app-status-danger)", labelKey: "statusError" },
  { key: "waitingInput", color: "var(--app-status-warning)", labelKey: "statusWaitingInput" },
  { key: "running", color: "var(--app-accent)", labelKey: "statusActive" },
  { key: "idle", color: "var(--app-text-tertiary)", labelKey: "statusIdle" },
] as const;

export default function LayoutStatusGrid({ summary }: { summary: LayoutStatusSummary }) {
  const { t } = useTranslation("dialogs");
  if (summary.total === 0) return null;

  return (
    <span className="grid shrink-0 grid-cols-2 gap-x-1.5 gap-y-1">
      {CELLS.map((cell) => {
        const count = summary[cell.key];
        return (
          <span
            key={cell.key}
            title={count > 0 ? t(cell.labelKey) : undefined}
            className="flex min-w-6 items-center justify-end gap-1"
          >
            {count > 0 ? (
              <>
                <span
                  aria-hidden
                  className="inline-block size-[7px] shrink-0 rounded-full"
                  style={{ backgroundColor: cell.color }}
                />
                <span className="text-[11px] leading-none tabular-nums">{count}</span>
              </>
            ) : null}
          </span>
        );
      })}
    </span>
  );
}
