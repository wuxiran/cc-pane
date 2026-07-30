// 工作空间拖放的落盘编排。拆出来是因为「改组」与「改序」是两条独立的后端写，
// 顺序不能反（见 applyPlan 注释）。
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { useWorkspacesStore } from "@/stores";
import { resolveWorkspaceDrop, type WorkspaceDropPlan } from "./workspaceDnd";

export function useWorkspaceDragDrop() {
  const { t } = useTranslation(["sidebar", "common"]);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const handleDragStart = useCallback(({ active }: DragStartEvent) => {
    setDraggingId(String(active.id));
  }, []);

  const handleDragCancel = useCallback(() => setDraggingId(null), []);

  const applyPlan = useCallback(
    async (plan: Exclude<WorkspaceDropPlan, null>) => {
      const store = useWorkspacesStore.getState();

      if (plan.kind === "reorder") {
        await store.reorder(plan.orderedNames);
        return;
      }

      const workspace = store.workspaces.find((ws) => ws.name === plan.workspaceName);
      if (!workspace) return;

      // 顺序不能反：reorder_workspaces 是 read-modify-write（get_workspace →
      // 改 sort_order → 写回）。若先排序，第二步 saveWorkspace 会拿前端内存里
      // 那份没有新 sort_order 的对象整体覆盖写，把刚落盘的顺序抹掉。
      // 反过来是安全的——先写的 group 会被 reorder 的 get_workspace 读到并保留。
      await store.saveWorkspace({ ...workspace, group: plan.nextGroup });

      if (plan.orderedNames) {
        try {
          await useWorkspacesStore.getState().reorder(plan.orderedNames);
        } catch {
          // 组已落盘、序未落盘。store.reorder 内部已做乐观回滚，但那份回滚的是
          // 排序前的快照（不含新 group），会让前端显示回退到旧组。重新拉真值而
          // 不是补偿性反向写——二次写同样可能失败，只会让状态更不可知。
          await useWorkspacesStore.getState().load();
          toast.warning(t("workspaceGroupOrderPartialFailed"));
          return;
        }
      }

      toast.success(
        plan.nextGroup
          ? t("workspaceGroupChanged", { group: plan.nextGroup })
          : t("workspaceGroupCleared"),
      );
    },
    [t],
  );

  const handleDragEnd = useCallback(
    async ({ active, over }: DragEndEvent) => {
      setDraggingId(null);
      if (!over || active.id === over.id) return;

      const overData = over.data.current as { type?: string; group?: string | null } | undefined;
      const plan = resolveWorkspaceDrop(useWorkspacesStore.getState().workspaces, String(active.id), {
        id: String(over.id),
        type: overData?.type,
        group: overData?.group,
      });
      if (!plan) return;

      try {
        await applyPlan(plan);
      } catch (e) {
        toast.error(
          plan.kind === "reorder"
            ? t("reorderFailed", { error: e })
            : t("workspaceMoveGroupFailed", { error: e }),
        );
      }
    },
    [applyPlan, t],
  );

  return { draggingId, handleDragStart, handleDragEnd, handleDragCancel };
}
