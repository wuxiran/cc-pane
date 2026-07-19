// 布局 ↔ 工作空间绑定的共享 UI：右键菜单项（绑定子菜单 + 解除绑定）与绑定徽标。
// 左下角 SortableLayoutRow 与顶部 LayoutTopBar 两处接同一份，保证行为一致。
import { Link2Off } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  ContextMenuCheckboxItem,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { usePanesStore, useWorkspacesStore } from "@/stores";
import { getLayoutWorkspaceBinding } from "@/utils/layoutWorkspace";
import type { LayoutEntry, PaneNode } from "@/types";

/** 右键菜单项：「绑定工作空间…」子菜单（勾选态）+ 仅 manual 绑定时的「解除绑定」 */
export function LayoutWorkspaceMenuItems({ layout }: { layout: LayoutEntry }) {
  const { t } = useTranslation("panes");
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const bindLayoutWorkspace = usePanesStore((s) => s.bindLayoutWorkspace);
  const unbindLayoutWorkspace = usePanesStore((s) => s.unbindLayoutWorkspace);
  const manualName = layout.workspaceName?.trim();

  return (
    <>
      <ContextMenuSub>
        <ContextMenuSubTrigger>{t("bindWorkspace")}</ContextMenuSubTrigger>
        <ContextMenuSubContent className="z-[130] max-h-64 w-48 overflow-y-auto">
          {workspaces.length === 0 ? (
            <ContextMenuItem disabled>{t("bindWorkspaceEmpty")}</ContextMenuItem>
          ) : (
            workspaces.map((workspace) => (
              <ContextMenuCheckboxItem
                key={workspace.id}
                checked={manualName === workspace.name}
                onSelect={() => bindLayoutWorkspace(layout.id, workspace.name)}
              >
                <span className="min-w-0 flex-1 truncate">
                  {workspace.alias || workspace.name}
                </span>
              </ContextMenuCheckboxItem>
            ))
          )}
        </ContextMenuSubContent>
      </ContextMenuSub>
      {manualName ? (
        <ContextMenuItem onSelect={() => unbindLayoutWorkspace(layout.id)}>
          <Link2Off />
          {t("unbindWorkspace")}
        </ContextMenuItem>
      ) : null}
    </>
  );
}

/**
 * 绑定徽标：manual = accent 12% 实底；derived = 虚线边 + 次级色，title 注明来源。
 * 当前布局的活树在 store 工作副本上，调用方需传 rootPane 覆盖以推导 derived 绑定。
 */
export function LayoutWorkspaceBadge({
  layout,
  rootPane,
  mini,
}: {
  layout: LayoutEntry;
  rootPane?: PaneNode;
  mini?: boolean;
}) {
  const { t } = useTranslation("panes");
  const binding = getLayoutWorkspaceBinding({
    workspaceName: layout.workspaceName,
    rootPane: rootPane ?? layout.rootPane,
  });
  if (!binding) return null;

  const manual = binding.source === "manual";
  const title = t(
    manual ? "layoutWorkspaceBadgeManual" : "layoutWorkspaceBadgeDerived",
    { name: binding.workspaceName },
  );

  return (
    <span
      title={title}
      data-binding-source={binding.source}
      className={`inline-flex shrink-0 items-center overflow-hidden rounded px-1 leading-none ${
        mini ? "max-w-[72px] py-0 text-[9px]" : "max-w-[88px] py-px text-[10px]"
      }`}
      style={
        manual
          ? {
              background: "color-mix(in srgb, var(--app-accent) 12%, transparent)",
              color: "var(--app-accent)",
            }
          : {
              border: "1px dashed color-mix(in srgb, var(--app-text-secondary) 45%, transparent)",
              color: "var(--app-text-secondary)",
            }
      }
    >
      <span className="truncate">{binding.workspaceName}</span>
    </span>
  );
}
