import { useCallback, useMemo } from "react";
import type { SplitPane } from "@/types";
import { usePanesStore } from "@/stores";
import PaneContainer from "./PaneContainer";
import SplitView from "./SplitView";

interface SplitContainerProps {
  pane: SplitPane;
}

export default function SplitContainer({ pane }: SplitContainerProps) {
  const resizePanes = usePanesStore((s) => s.resizePanes);

  const handleDragEnd = useCallback(
    (sizes: number[]) => {
      const total = sizes.reduce((a, b) => a + b, 0);
      if (total <= 0 || sizes.length === 0) return;

      // 归一化为百分比，确保总和恰好为 100%
      const rounded = sizes.map(
        (s) => Math.round((s / total) * 1000) / 10
      );
      const sum = rounded.slice(0, -1).reduce((a, b) => a + b, 0);
      rounded[rounded.length - 1] = Math.round((100 - sum) * 10) / 10;

      resizePanes(pane.id, rounded);
    },
    [pane.id, resizePanes]
  );

  const childKeys = useMemo(
    () => pane.children.map((child) => child.id),
    [pane.children]
  );

  return (
    <div className="h-full split-container">
      <SplitView
        vertical={pane.direction === "vertical"}
        sizes={pane.sizes}
        minSize={50}
        onDragEnd={handleDragEnd}
        keys={childKeys}
      >
        {pane.children.map((child) => (
          <PaneContainer key={child.id} pane={child} />
        ))}
      </SplitView>
    </div>
  );
}
