import { memo } from "react";
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

const statusLabels: Record<string, string> = {
  active: "运行中",
  waitingInput: "等待输入",
  idle: "空闲",
  exited: "已退出",
};

export default memo(function StatusIndicator({ status, size = 8 }: StatusIndicatorProps) {
  if (!status) return null;

  return (
    <span
      className="inline-block rounded-full shrink-0 transition-colors duration-300"
      title={statusLabels[status] ?? ""}
      style={{
        width: size,
        height: size,
        backgroundColor: statusColors[status] ?? "#6e6e73",
      }}
    />
  );
});
