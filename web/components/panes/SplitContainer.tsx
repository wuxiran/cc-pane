import { useCallback, useMemo } from "react";
import type { SplitPane } from "@/types";
import { BREAKPOINT_ORDER } from "@/lib/breakpoints";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { usePanesStore } from "@/stores";
import PaneContainer from "./PaneContainer";
import SplitView from "./SplitView";

/**
 * 窄档（< md）横向分屏的列宽下限：≈35 cols（默认字号）可读底线，
 * 两列 + 3px sash 在 sm 上沿（主区 ≈ 620px）内不触发滚动，xs 才出现横滚。
 * 评审见 docs/splitview-narrow.md。
 */
export const NARROW_PANE_MIN_WIDTH_PX = 320;

interface SplitContainerProps {
  pane: SplitPane;
}

export default function SplitContainer({ pane }: SplitContainerProps) {
  const resizePanes = usePanesStore((s) => s.resizePanes);
  const breakpoint = useBreakpoint();
  // md 以下生效、lg 以上零行为变化：下限与 overflow 均条件挂载，宽档渲染输出不变。
  const narrowHorizontal =
    BREAKPOINT_ORDER.indexOf(breakpoint) < BREAKPOINT_ORDER.indexOf("md") &&
    pane.direction === "horizontal";

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
    <div
      className="h-full w-full min-h-0 min-w-0 split-container"
      style={{
        background: "var(--app-panel-bg-effective)",
        // 窄档横向分屏：列宽下限生效后内容可能超出可见宽，容器转为横向滚动；
        // 纵向锁定 hidden，避免 overflow 另一轴被提升为 auto 引入纵滚动条振荡。
        overflowX: narrowHorizontal ? "auto" : undefined,
        overflowY: narrowHorizontal ? "hidden" : undefined,
      }}
    >
      <SplitView
        vertical={pane.direction === "vertical"}
        sizes={pane.sizes}
        minSize={50}
        paneMinWidth={narrowHorizontal ? NARROW_PANE_MIN_WIDTH_PX : undefined}
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
