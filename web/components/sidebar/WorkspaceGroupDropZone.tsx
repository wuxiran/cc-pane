// 分组头的 drop 目标包装。折叠的分组照样能接收——头始终渲染，只有成员会被省略。
import { useDroppable } from "@dnd-kit/core";
import WorkspaceGroupHeader from "./WorkspaceGroupHeader";
import { workspaceGroupDropId } from "./workspaceDnd";

interface WorkspaceGroupDropZoneProps {
  /** 分组显示名 */
  group: string;
  /** droppable 键：普通组用组名，未分组段用 UNGROUPED_WORKSPACE_FILTER */
  groupKey: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  /** 是否正在拖工作空间（用于给所有候选靶一个弱提示） */
  dragging: boolean;
}

export default function WorkspaceGroupDropZone({
  group,
  groupKey,
  count,
  collapsed,
  onToggle,
  dragging,
}: WorkspaceGroupDropZoneProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: workspaceGroupDropId(groupKey),
    data: { type: "workspace-group", group: groupKey },
  });

  return (
    <div ref={setNodeRef}>
      <WorkspaceGroupHeader
        group={group}
        count={count}
        collapsed={collapsed}
        onToggle={onToggle}
        dropActive={dragging && isOver}
        dropCandidate={dragging && !isOver}
      />
    </div>
  );
}
