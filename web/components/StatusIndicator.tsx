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
 *   - thinking / toolRunning / compacting → 绿色家族（在干活）
 *   - waitingInput → 橙（等用户）
 *   - error → 红（出错）
 *   - idle → 灰（真·空闲，TurnEnd hook 上报）
 *   - exited → 暗灰
 *   - initializing → 灰渐变 + 闪烁
 *   - toolRunning / compacting 叠加 pulse 动效
 *
 * legacy `active` 颜色保持原绿色（兼容 hook 未启用时的 PTY 推断回退）。
 */
const statusColors: Record<string, string> = {
  initializing: "#8e8e93",
  idle: "#8e8e93",
  thinking: "#30d158",
  toolRunning: "#30d158",
  compacting: "#0a84ff",
  waitingInput: "#ffd60a",
  error: "#ff453a",
  exited: "#48484a",
  active: "#30d158", // legacy
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
        backgroundColor: statusColors[status] ?? "#6e6e73",
      }}
    />
  );
});
