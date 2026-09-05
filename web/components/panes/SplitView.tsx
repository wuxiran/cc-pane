import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { setDragging } from "@/stores/splitDragState";

interface SplitViewProps {
  /** true = 垂直分屏（上下排列），false = 水平分屏（左右排列） */
  vertical: boolean;
  /** 各 pane 的百分比大小，如 [50, 50] */
  sizes: number[];
  /** 每个 pane 的最小像素尺寸 */
  minSize?: number;
  /**
   * 每个 pane 的布局层最小像素宽度（窄档保护，docs/splitview-narrow.md）。
   * 仅水平分屏在窄档由 SplitContainer 传入；未传时 minWidth 保持 0，行为与旧版一致。
   */
  paneMinWidth?: number;
  /** 拖拽结束时回调，传入新的百分比数组 */
  onDragEnd: (sizes: number[]) => void;
  children: React.ReactNode[];
  /** 与 children 一一对应的稳定唯一标识，用于 React reconciliation */
  keys: string[];
  /** zoom 期间隐藏全部 sash（0 宽支不可拖拽） */
  hideSashes?: boolean;
}

export default function SplitView({
  vertical,
  sizes,
  minSize = 50,
  paneMinWidth,
  onDragEnd,
  children,
  keys,
  hideSashes = false,
}: SplitViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sizesRef = useRef(sizes);
  const cleanupRef = useRef<(() => void) | null>(null);
  const [activeSash, setActiveSash] = useState<number | null>(null);

  // 同步 props → ref（store 更新时保持 ref 最新）
  useEffect(() => {
    sizesRef.current = sizes;
  }, [sizes]);

  // 组件卸载时清理正在进行的拖拽
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  const handleSashPointerDown = useCallback(
    (index: number, e: React.PointerEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;

      const panes = container.querySelectorAll<HTMLElement>(
        ":scope > [data-splitview-pane]"
      );
      if (panes.length < index + 2) return;

      const totalSize = vertical
        ? container.clientHeight
        : container.clientWidth;
      if (totalSize === 0) return;

      const startPos = vertical ? e.clientY : e.clientX;
      const startSizes = [...sizesRef.current];
      const minPercent = (minSize / totalSize) * 100;

      let rafId = 0;

      const onMove = (ev: PointerEvent) => {
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          const delta =
            (((vertical ? ev.clientY : ev.clientX) - startPos) / totalSize) *
            100;

          let newLeft = startSizes[index] + delta;
          let newRight = startSizes[index + 1] - delta;

          // 应用最小尺寸约束
          if (newLeft < minPercent) {
            newRight += newLeft - minPercent;
            newLeft = minPercent;
          }
          if (newRight < minPercent) {
            newLeft += newRight - minPercent;
            newRight = minPercent;
          }

          const newSizes = [...sizesRef.current];
          newSizes[index] = newLeft;
          newSizes[index + 1] = newRight;
          sizesRef.current = newSizes;

          // 直接操作 DOM，不触发 React re-render
          panes[index].style.flexBasis = `${newLeft}%`;
          panes[index + 1].style.flexBasis = `${newRight}%`;
        });
      };

      const cleanup = () => {
        cancelAnimationFrame(rafId);
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("blur", onWindowBlur);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        setDragging(false);
        setActiveSash(null);
        cleanupRef.current = null;
      };

      const onUp = () => {
        cleanup();
        onDragEnd([...sizesRef.current]);
      };

      const onCancel = () => {
        cleanup();
      };

      const onWindowBlur = () => {
        cleanup();
      };

      // 存储 cleanup 函数，供组件卸载、pointercancel 和窗口失焦调用
      setDragging(true);
      setActiveSash(index);
      cleanupRef.current = cleanup;

      // 防止拖拽时选中文本
      document.body.style.userSelect = "none";
      document.body.style.cursor = vertical ? "row-resize" : "col-resize";
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onCancel);
      window.addEventListener("blur", onWindowBlur);
    },
    [vertical, minSize, onDragEnd]
  );

  // 统一渲染路径：始终使用 .map() + Fragment key
  // 这样 2→1 子节点切换时，React 通过 key 识别存活的子组件并复用，
  // 不会 unmount/remount（避免 TerminalView 重建导致 UI 假死）
  const effectiveSizes =
    sizes.length === children.length
      ? sizes
      : children.map(() => 100 / children.length);

  return (
    <div
      ref={containerRef}
      className="splitview-container"
      style={{
        display: "flex",
        flexDirection: vertical ? "column" : "row",
        height: "100%",
        width: "100%",
      }}
    >
      {children.map((child, i) => (
        <Fragment key={keys[i]}>
          {i > 0 && !hideSashes && (
            <div
              className={`splitview-sash ${vertical ? "horizontal" : "vertical"}`}
              data-splitview-sash={i - 1}
              data-dragging={activeSash === i - 1 ? "true" : undefined}
              role="separator"
              aria-orientation={vertical ? "horizontal" : "vertical"}
              onPointerDown={(e) => handleSashPointerDown(i - 1, e)}
            />
          )}
          <div
            data-splitview-pane
            style={{
              flexBasis: `${effectiveSizes[i]}%`,
              flexGrow: 0,
              flexShrink: 0,
              overflow: "hidden",
              // 窄档列宽下限：只动 min-width，flexBasis 百分比数学保持不变；
              // 断点穿越时 min-width 变化一次，经 min-width 过渡平滑落地
              // （RO 只观察 xterm host，此处改动不自观察，无 refit 回路）。
              minWidth: paneMinWidth ? `${paneMinWidth}px` : 0,
              transition: paneMinWidth
                ? "min-width var(--dur) var(--ease-out)"
                : undefined,
              minHeight: 0,
            }}
          >
            {child}
          </div>
        </Fragment>
      ))}
    </div>
  );
}
