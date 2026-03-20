import { useCallback } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { useState } from "react";
import { usePanesStore } from "@/stores";
import type { Tab } from "@/types";

interface DndPaneProviderProps {
  children: React.ReactNode;
}

/**
 * DnD 上下文提供者
 * 包裹在面板树外层，使标签可以跨面板拖拽
 */
export default function DndPaneProvider({ children }: DndPaneProviderProps) {
  const moveTab = usePanesStore((s) => s.moveTab);
  const reorderTabs = usePanesStore((s) => s.reorderTabs);
  const allPanels = usePanesStore((s) => s.allPanels);

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
      setActiveTab(data.tab as Tab);
    }
  }, []);

  const handleDragOver = useCallback((_event: DragOverEvent) => {
    // 可以在此处添加拖拽预览效果
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setActiveTab(null);

    if (!over) return;

    const activeData = active.data.current;
    const overData = over.data.current;

    if (!activeData || activeData.type !== "tab") return;

    const fromPaneId = activeData.paneId as string;
    const tabId = active.id as string;

    if (overData?.type === "tab") {
      const toPaneId = overData.paneId as string;

      if (fromPaneId === toPaneId) {
        // 同面板内排序
        const panels = allPanels();
        const panel = panels.find((p) => p.id === fromPaneId);
        if (!panel) return;

        const fromIndex = panel.tabs.findIndex((t) => t.id === tabId);
        const toIndex = panel.tabs.findIndex((t) => t.id === over.id);
        if (fromIndex !== -1 && toIndex !== -1 && fromIndex !== toIndex) {
          reorderTabs(fromPaneId, fromIndex, toIndex);
        }
      } else {
        // 跨面板移动
        const toPanel = allPanels().find((p) => p.id === toPaneId);
        if (!toPanel) return;
        const toIndex = toPanel.tabs.findIndex((t) => t.id === over.id);
        moveTab(fromPaneId, toPaneId, tabId, toIndex >= 0 ? toIndex : undefined);
      }
    }
  }, [allPanels, moveTab, reorderTabs]);

  const handleDragCancel = useCallback(() => {
    setActiveTab(null);
  }, []);

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {children}
      <DragOverlay dropAnimation={null}>
        {activeTab && (
          <div className="flex items-center gap-2 px-4 h-10 rounded-lg text-sm font-medium bg-blue-500/20 border border-blue-500/40 text-blue-300 backdrop-blur-lg shadow-lg">
            <span className="max-w-[120px] truncate">{activeTab.title}</span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

