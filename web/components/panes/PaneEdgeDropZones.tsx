// 拖拽落边分屏：拖 tab 到 pane 右/下边缘时显示半格预览，松手在旁开新窗格。
// 落点条只在拖拽 tab 期间渲染（draggingTab），且 pointer-events-none——
// dnd-kit 用 DOM rect 做碰撞（rectIntersection），不依赖指针命中，
// 常驻渲染会与 tab 落点竞争、还可能挡住终端内容区的正常右键。
import { useDroppable } from "@dnd-kit/core";
import { usePaneEdgeDropStore } from "@/stores/usePaneEdgeDropStore";

interface EdgeStripProps {
  paneId: string;
  edge: "right" | "bottom";
}

function EdgeStrip({ paneId, edge }: EdgeStripProps) {
  const { setNodeRef } = useDroppable({
    id: `pane-edge-${paneId}-${edge}`,
    data: { type: "pane-edge", paneId, edge },
  });
  return (
    <div
      ref={setNodeRef}
      data-testid={`pane-edge-${edge}`}
      className={`pointer-events-none absolute z-20 ${
        edge === "right" ? "top-0 bottom-0 right-0 w-8" : "left-0 right-0 bottom-0 h-8"
      }`}
    />
  );
}

export default function PaneEdgeDropZones({ paneId }: { paneId: string }) {
  const dragging = usePaneEdgeDropStore((s) => s.draggingTab);
  const preview = usePaneEdgeDropStore((s) =>
    s.preview?.paneId === paneId ? s.preview : null
  );
  if (!dragging) return null;
  return (
    <>
      <EdgeStrip paneId={paneId} edge="right" />
      <EdgeStrip paneId={paneId} edge="bottom" />
      {preview && (
        <div
          data-testid="pane-edge-preview"
          className={`pointer-events-none absolute z-10 border-2 border-[color-mix(in_srgb,var(--app-accent)_60%,transparent)] bg-[color-mix(in_srgb,var(--app-accent)_15%,transparent)] ${
            preview.edge === "right"
              ? "top-0 bottom-0 right-0 left-1/2"
              : "left-0 right-0 bottom-0 top-1/2"
          }`}
        />
      )}
    </>
  );
}
