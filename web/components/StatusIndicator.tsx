import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { TerminalStatusType } from "@/types";

interface StatusIndicatorProps {
  status: TerminalStatusType | null;
  /** 当前运行的工具名（仅 toolRunning 状态下展示在 tooltip）。 */
  toolName?: string | null;
  size?: number;
}

/**
 * 状态点。阶段 2 扩充为 8 状态：
 *   - thinking / toolRunning / compacting → accent（在干活）
 *   - waitingInput → warning（等用户）
 *   - error → 红（出错）
 *   - idle → 灰（真·空闲，TurnEnd hook 上报）
 *   - exited → 暗灰
 *   - initializing → 灰渐变 + 闪烁
 *   - toolRunning / compacting 叠加 pulse 动效
 *
 * legacy `active` 沿用 accent（兼容 hook 未启用时的 PTY 推断回退）。
 */
const statusColors: Record<string, string> = {
  initializing: "var(--app-text-tertiary)",
  idle: "var(--app-text-tertiary)",
  thinking: "var(--app-accent)",
  toolRunning: "var(--app-accent)",
  compacting: "var(--app-accent)",
  waitingInput: "var(--app-status-warning)",
  error: "var(--app-status-danger)",
  exited: "var(--app-text-tertiary)",
  active: "var(--app-accent)", // legacy
};

const PULSING_STATUSES = new Set(["toolRunning", "compacting", "initializing"]);

const statusKeyMap = {
  initializing: "statusInitializing",
  idle: "statusIdle",
  thinking: "statusThinking",
  toolRunning: "statusToolRunning",
  compacting: "statusCompacting",
  waitingInput: "statusWaitingInput",
  error: "statusError",
  exited: "statusExited",
  active: "statusActive",
} as const;

export default memo(function StatusIndicator({ status, toolName, size = 8 }: StatusIndicatorProps) {
  const { t } = useTranslation("dialogs");

  if (!status) return null;

  const labelKey = statusKeyMap[status as keyof typeof statusKeyMap];
  const baseLabel = labelKey ? t(labelKey) : "";
  // toolRunning 状态下 tooltip 拼上工具名，让用户知道在跑什么
  const label = status === "toolRunning" && toolName ? `${baseLabel}: ${toolName}` : baseLabel;
  const isPulsing = PULSING_STATUSES.has(status);

  return (
    <span
      className={`inline-block rounded-full shrink-0 transition-colors duration-[var(--dur)] ${
        isPulsing ? "cc-status-pulse" : ""
      }`}
      title={label}
      style={{
        width: size,
        height: size,
        backgroundColor: statusColors[status] ?? "var(--app-text-tertiary)",
      }}
    />
  );
});
