import { useCallback } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  rectIntersection,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { usePanesStore } from "@/stores";
import { usePaneEdgeDropStore } from "@/stores/usePaneEdgeDropStore";
import type { Tab } from "@/types";
import { devDebugLog } from "@/utils/devLogger";
import { resolveDndDrop } from "./paneDndRouting";

interface DndPaneProviderProps {
  children: React.ReactNode;
}

const DND_DEBUG = import.meta.env.DEV;

function debugDnd(event: string, payload: Record<string, unknown>): void {
  if (!DND_DEBUG) return;
  devDebugLog("pane-dnd-debug", event, payload);
}

/**
 * DnD 上下文提供者
 * 包裹在面板树外层，使标签可以跨面板拖拽
 */
export default function DndPaneProvider({ children }: DndPaneProviderProps) {
  const { t } = useTranslation("panes");
  const moveTab = usePanesStore((s) => s.moveTab);
  const reorderTabs = usePanesStore((s) => s.reorderTabs);
  const allPanels = usePanesStore((s) => s.allPanels);
  const moveTabToLayoutPane = usePanesStore((s) => s.moveTabToLayoutPane);
  const reorderLayouts = usePanesStore((s) => s.reorderLayouts);

  const [activeTab, setActiveTab] = useState<Tab | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // 至少拖动 8px 才启动，避免误触
      },
    })
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const { active } = event;
    const data = active.data.current;
    if (data?.type === "tab") {
      const tab = data.tab as Tab;
      debugDnd("drag.start", {
        tabId: tab.id,
        fromPaneId: data.paneId ?? null,
        sessionId: tab.sessionId ?? null,
        cliTool: tab.cliTool ?? (tab.launchClaude ? "claude" : "none"),
      });
      setActiveTab(tab);
      // 边缘落点条只在拖拽 tab 期间渲染（见 PaneEdgeDropZones 的说明）
      usePaneEdgeDropStore.getState().setDraggingTab(true);
    }
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    // 悬停到边缘落点条 → 通知 Panel 渲染半格分屏预览
    const over = event.over;
    const edgeDrop = usePaneEdgeDropStore.getState();
    if (over?.data.current?.type === "pane-edge") {
      const paneId = over.data.current.paneId as string;
      const edge = over.data.current.edge as "right" | "bottom";
      const prev = edgeDrop.preview;
      if (prev?.paneId !== paneId || prev?.edge !== edge) {
        edgeDrop.setPreview({ paneId, edge });
      }
      return;
    }
    if (edgeDrop.preview) edgeDrop.setPreview(null);
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setActiveTab(null);
    const edgeDrop = usePaneEdgeDropStore.getState();
    edgeDrop.setDraggingTab(false);
    edgeDrop.setPreview(null);

    const store = usePanesStore.getState();
    const action = resolveDndDrop(
      { id: String(active.id), data: active.data.current },
      over ? { id: String(over.id), data: over.data.current } : null,
      {
        panels: allPanels(),
        layouts: store.layouts,
        currentLayoutId: store.currentLayoutId,
      },
    );
    if (!action) return;

    switch (action.kind) {
      case "reorder-tabs":
        debugDnd("drag.end.reorder", action);
        reorderTabs(action.paneId, action.fromIndex, action.toIndex);
        break;
      case "move-tab": {
        const movedTab = active.data.current?.tab as Tab | undefined;
        debugDnd("drag.end.cross-pane", {
          ...action,
          sessionId: movedTab?.sessionId ?? null,
          cliTool: movedTab?.cliTool ?? (movedTab?.launchClaude ? "claude" : "none"),
        });
        moveTab(action.fromPaneId, action.toPaneId, action.tabId, action.toIndex);
        break;
      }
      case "split-move-tab": {
        debugDnd("drag.end.split-move", action);
        store.splitAndDropTab(
          action.toPaneId,
          action.fromPaneId,
          action.tabId,
          action.edge === "right" ? "right" : "down",
        );
        break;
      }
      case "move-tab-to-layout": {
        // 第 4 参（toPaneId）留空 → store 取目标布局第一个 panel。
        // 不要传 layout.activePaneId：它可能指向 split 节点，store 会静默 return，
        // 表现成"拖了没反应"。
        debugDnd("drag.end.to-layout", action);
        moveTabToLayoutPane(action.fromPaneId, action.toLayoutId, action.tabId);
        const target = store.layouts.find((layout) => layout.id === action.toLayoutId);
        // tab 从视野里消失且不切布局，必须给瞬态确认
        toast.success(t("tabMovedToLayout", { name: target?.name ?? "" }));
        break;
      }
      case "reorder-layouts":
        debugDnd("drag.end.reorder-layouts", action);
        reorderLayouts(action.fromIndex, action.toIndex);
        break;
    }
  }, [allPanels, moveTab, moveTabToLayoutPane, reorderLayouts, reorderTabs, t]);

  const handleDragCancel = useCallback(() => {
    setActiveTab(null);
    const edgeDrop = usePaneEdgeDropStore.getState();
    edgeDrop.setDraggingTab(false);
    edgeDrop.setPreview(null);
  }, []);

  // 碰撞算法按被拖对象分流：布局条合并进来之前用的是 closestCenter，
  // tab 区用默认的 rectIntersection。统一成任一个都会改掉另一边的手感。
  const collisionDetection = useCallback(
    (args: Parameters<typeof rectIntersection>[0]) =>
      args.active.data.current?.type === "layout" ? closestCenter(args) : rectIntersection(args),
    [],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {children}
      <DragOverlay dropAnimation={null}>
        {activeTab && (
          <div className="flex items-center gap-2 px-4 h-10 rounded-lg text-sm font-medium bg-[color-mix(in_srgb,var(--app-accent)_20%,transparent)] border border-[color-mix(in_srgb,var(--app-accent)_40%,transparent)] text-[var(--app-accent)] backdrop-blur-lg shadow-lg">
            <span className="max-w-[120px] truncate">{activeTab.title}</span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

