import { useMemo } from "react";
import { Eraser, FolderMinus, FolderTree, Palette, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  ContextMenuCheckboxItem,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { useWorkspacesStore } from "@/stores";
import { normalizedWorkspaceGroup } from "@/stores/useWorkspacesStore";
import { WORKSPACE_COLORS, type Workspace, type WorkspaceColor } from "@/types";
import WorkspaceColorDot from "./WorkspaceColorDot";

const COLOR_LABEL_KEYS = {
  red: "workspaceColorRed",
  amber: "workspaceColorAmber",
  green: "workspaceColorGreen",
  blue: "workspaceColorBlue",
  purple: "workspaceColorPurple",
  pink: "workspaceColorPink",
  cyan: "workspaceColorCyan",
  gray: "workspaceColorGray",
} as const satisfies Record<WorkspaceColor, string>;

interface WorkspaceAppearanceMenuProps {
  workspace: Workspace;
  onNewGroup: () => void;
}

export default function WorkspaceAppearanceMenu({
  workspace,
  onNewGroup,
}: WorkspaceAppearanceMenuProps) {
  const { t } = useTranslation("sidebar");
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const saveWorkspace = useWorkspacesStore((state) => state.saveWorkspace);
  const currentGroup = normalizedWorkspaceGroup(workspace);
  const groups = useMemo(() => {
    const values = new Set<string>();
    for (const item of workspaces) {
      const group = normalizedWorkspaceGroup(item);
      if (group) values.add(group);
    }
    return [...values];
  }, [workspaces]);

  const saveAppearance = async (patch: Pick<Workspace, "group" | "color">) => {
    try {
      await saveWorkspace({ ...workspace, ...patch });
    } catch (error) {
      toast.error(t("workspaceAppearanceSaveFailed", { error }));
    }
  };

  return (
    <>
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <FolderTree /> {t("workspaceSetGroup")}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-48">
          {groups.map((group) => (
            <ContextMenuCheckboxItem
              key={group}
              checked={currentGroup === group}
              onCheckedChange={(checked) => {
                if (checked)
                  void saveAppearance({ group, color: workspace.color });
              }}
            >
              <span className="truncate">{group}</span>
            </ContextMenuCheckboxItem>
          ))}
          {groups.length > 0 ? <ContextMenuSeparator /> : null}
          <ContextMenuItem onSelect={onNewGroup}>
            <Plus /> {t("workspaceNewGroup")}
          </ContextMenuItem>
          {currentGroup ? (
            <ContextMenuItem
              onSelect={() =>
                void saveAppearance({
                  group: undefined,
                  color: workspace.color,
                })
              }
            >
              <FolderMinus /> {t("workspaceRemoveGroup")}
            </ContextMenuItem>
          ) : null}
        </ContextMenuSubContent>
      </ContextMenuSub>

      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Palette /> {t("workspaceSetColor")}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="grid w-36 grid-cols-4 gap-1 p-2">
          {WORKSPACE_COLORS.map((color) => (
            <ContextMenuItem
              key={color}
              aria-label={t(COLOR_LABEL_KEYS[color])}
              aria-current={workspace.color === color ? "true" : undefined}
              onSelect={() =>
                void saveAppearance({ group: workspace.group, color })
              }
              className={`h-7 justify-center p-0 ${workspace.color === color ? "bg-[var(--app-active-bg)] ring-1 ring-[var(--app-accent)]" : ""}`}
            >
              <WorkspaceColorDot color={color} size="md" />
            </ContextMenuItem>
          ))}
          <ContextMenuSeparator className="col-span-4" />
          <ContextMenuItem
            disabled={!workspace.color}
            onSelect={() =>
              void saveAppearance({ group: workspace.group, color: undefined })
            }
            className="col-span-4"
          >
            <Eraser /> {t("workspaceClearColor")}
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
    </>
  );
}
