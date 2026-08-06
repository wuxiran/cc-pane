import { memo } from "react";
import { useTranslation } from "react-i18next";
import { isStatusPulsing, statusColorToken, statusLabelKey } from "@/lib/statusPresentation";
import type { TerminalStatusType } from "@/types";

interface StatusIndicatorProps {
  status: TerminalStatusType | null;
  /** 当前运行的工具名（仅 toolRunning 状态下展示在 tooltip）。 */
  toolName?: string | null;
  size?: number;
}

export default memo(function StatusIndicator({ status, toolName, size = 8 }: StatusIndicatorProps) {
  const { t } = useTranslation("dialogs");

  if (!status) return null;

  const labelKey = statusLabelKey(status);
  const baseLabel = labelKey ? t(labelKey) : "";
  // toolRunning 状态下 tooltip 拼上工具名，让用户知道在跑什么
  const label = status === "toolRunning" && toolName ? `${baseLabel}: ${toolName}` : baseLabel;
  const isPulsing = isStatusPulsing(status);

  return (
    <span
      className={`inline-block rounded-full shrink-0 transition-colors duration-[var(--dur)] ${
        isPulsing ? "cc-status-pulse" : ""
      }`}
      title={label}
      style={{
        width: size,
        height: size,
        backgroundColor: statusColorToken(status),
      }}
    />
  );
});
