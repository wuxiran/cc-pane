import { useState, useCallback } from "react";
import { Allotment } from "allotment";
import type { SplitPane } from "@/types";
import { usePanesStore } from "@/stores";
import PaneContainer from "./PaneContainer";
import "allotment/dist/style.css";

interface SplitContainerProps {
  pane: SplitPane;
}

export default function SplitContainer({ pane }: SplitContainerProps) {
  const resizePanes = usePanesStore((s) => s.resizePanes);
  const [isResizing, setIsResizing] = useState(false);

  // allotment onChange 返回像素大小数组，需要转成百分比存储
  const handleChange = useCallback(
    (sizes: number[]) => {
      const total = sizes.reduce((a, b) => a + b, 0);
      if (total > 0) {
        const percentages = sizes.map((s) => (s / total) * 100);
        resizePanes(pane.id, percentages);
      }
    },
    [pane.id, resizePanes]
  );

  function handleMouseDown(e: React.MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.closest(".sash-container") || target.classList.contains("sash")) {
      setIsResizing(true);
      const handleMouseUp = () => setIsResizing(false);
      document.addEventListener("mouseup", handleMouseUp, { once: true });
    }
  }

  return (
    <div
      className="h-full split-container"
      style={{ pointerEvents: isResizing ? "none" : undefined }}
      onMouseDown={handleMouseDown}
    >
      <Allotment
        vertical={pane.direction === "vertical"}
        proportionalLayout
        onChange={handleChange}
      >
        {pane.children.map((child, index) => (
          <Allotment.Pane
            key={child.id}
            preferredSize={`${pane.sizes[index]}%`}
            minSize={50}
          >
            <PaneContainer pane={child} />
          </Allotment.Pane>
        ))}
      </Allotment>
    </div>
  );
}
