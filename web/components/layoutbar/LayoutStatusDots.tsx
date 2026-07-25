import { useMemo } from "react";
import StatusIndicator from "@/components/StatusIndicator";
import { collectPanels } from "@/stores/paneTreeHelpers";
import type { PaneNode, TerminalStatusInfo } from "@/types";
import { aggregatePaneStatus } from "@/utils/layoutStatus";

const MAX_LAYOUT_STATUS_DOTS = 6;

export default function LayoutStatusDots({
  rootPane,
  statusMap,
}: {
  rootPane: PaneNode;
  statusMap: Map<string, TerminalStatusInfo>;
}) {
  const paneStatuses = useMemo(
    () => collectPanels(rootPane).map((panel) =>
      aggregatePaneStatus(
        panel.tabs.map((tab) => (tab.sessionId ? statusMap.get(tab.sessionId)?.status ?? null : null)),
      ),
    ),
    [rootPane, statusMap],
  );
  const visibleStatuses = paneStatuses.slice(0, MAX_LAYOUT_STATUS_DOTS);
  const overflow = paneStatuses.length - visibleStatuses.length;

  return (
    <span className="flex shrink-0 items-center gap-[3px]">
      {visibleStatuses.map((status, index) => (
        status ? (
          <StatusIndicator key={index} status={status} size={6} />
        ) : (
          <span
            key={index}
            className="inline-block h-[6px] w-[6px] shrink-0 rounded-full border"
            style={{ borderColor: "var(--app-border)" }}
          />
        )
      ))}
      {overflow > 0 ? (
        <span className="text-[9px] leading-none" style={{ color: "var(--app-text-tertiary)" }}>
          +{overflow}
        </span>
      ) : null}
    </span>
  );
}
