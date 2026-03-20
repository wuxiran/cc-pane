import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { TerminalStatusType } from "@/types";

interface StatusIndicatorProps {
  status: TerminalStatusType | null;
  size?: number;
}

const statusColors: Record<string, string> = {
  active: "#30d158",
  waitingInput: "#ffd60a",
  idle: "#8e8e93",
  exited: "#ff453a",
};

const statusKeyMap = {
  active: "statusActive",
  waitingInput: "statusWaitingInput",
  idle: "statusIdle",
  exited: "statusExited",
} as const;

export default memo(function StatusIndicator({ status, size = 8 }: StatusIndicatorProps) {
  const { t } = useTranslation("dialogs");

  if (!status) return null;

  const labelKey = statusKeyMap[status as keyof typeof statusKeyMap];

  return (
    <span
      className="inline-block rounded-full shrink-0 transition-colors duration-300"
      title={labelKey ? t(labelKey) : ""}
      style={{
        width: size,
        height: size,
        backgroundColor: statusColors[status] ?? "#6e6e73",
      }}
    />
  );
});
