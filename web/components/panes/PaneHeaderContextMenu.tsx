// pane 头部（标签条空白区）右键菜单：窗格级操作的一等入口。
// 全部动作走命令注册中心（菜单项自动带当前键位），不再新增散装接线。
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import CommandMenuItem, { CommandShortcutHint } from "@/components/commands/CommandMenuItem";
import { usePanesStore } from "@/stores";

interface PaneHeaderContextMenuProps {
  paneId: string;
}

/**
 * 标签条空白区右键的包装器：children 是整条 TabBar。
 * 右击落在标签上时让位给标签自己的菜单（TabContextMenu 在事件目标上游先开），
 * preventDefault 后 Radix 会跳过本触发器的打开逻辑（事件合并语义）。
 */
export function PaneHeaderContextMenuWrapper({
  paneId,
  children,
}: PaneHeaderContextMenuProps & { children: React.ReactElement }) {
  const handleBarContextMenu = useCallback((event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest("[data-tab-id]")) {
      event.preventDefault();
    }
  }, []);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild onContextMenu={handleBarContextMenu}>
        {children}
      </ContextMenuTrigger>
      <PaneHeaderContextMenu paneId={paneId} />
    </ContextMenu>
  );
}

export default function PaneHeaderContextMenu({ paneId }: PaneHeaderContextMenuProps) {
  const { t } = useTranslation("panes");
  const closedTabCount = usePanesStore((s) => s.closedTabs.length);
  const zoomed = usePanesStore((s) => s.zoomedPaneId === paneId);

  return (
    <ContextMenuContent className="w-56">
      <CommandMenuItem commandId="new-tab" />
      <ContextMenuSeparator />
      {/* 菜单文案沿用「面板 · 拆分到右/下」，与终端格子分屏区分 */}
      <CommandMenuItem commandId="split-right" ctx={{ paneId }} label={t("splitPanelRight")} />
      <CommandMenuItem commandId="split-down" ctx={{ paneId }} label={t("splitPanelDown")} />
      <CommandMenuItem
        commandId="split-clone-tab"
        ctx={{ paneId, direction: "right" }}
        label={t("splitCloneRight")}
      />
      <CommandMenuItem
        commandId="split-clone-tab"
        ctx={{ paneId, direction: "down" }}
        label={t("splitCloneDown")}
      />
      <ContextMenuSeparator />
      <CommandMenuItem
        commandId="zoom-pane"
        ctx={{ paneId }}
        label={zoomed ? t("unzoomPane") : t("zoomPane")}
      />
      <CommandMenuItem commandId="equalize-panes" />
      <ContextMenuSeparator />
      <ContextMenuItem
        inset
        disabled={closedTabCount === 0}
        onSelect={() => usePanesStore.getState().reopenClosedTab(paneId)}
      >
        {t("restoreClosedTabs", { count: closedTabCount })}
        <CommandShortcutHint commandId="reopen-closed-tab" />
      </ContextMenuItem>
      <CommandMenuItem
        commandId="close-pane"
        ctx={{ paneId }}
        label={t("closePane")}
        variant="destructive"
      />
    </ContextMenuContent>
  );
}
