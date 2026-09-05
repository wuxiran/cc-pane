// tab 右键菜单：从 TabBar 拆出（行数棘轮约束），行为与外观保持不变。
// 新增「恢复已关闭标签」入口直接读 usePanesStore（与 TabQuickCommandsMenu 直读 store 同形态），
// 避免 Panel → TabBar → 此处的三层 props 透传。
import {
  Copy,
  CopyPlus,
  ExternalLink,
  FolderTree,
  Maximize2,
  Minimize2,
  PanelBottom,
  PanelRight,
  Pencil,
  Send,
  Settings2,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { usePanesStore } from "@/stores";
import type { Tab } from "@/types";
import type { TFunction } from "i18next";
import CommandMenuItem, { CommandShortcutHint } from "@/components/commands/CommandMenuItem";
import TabQuickCommandsMenu from "./TabQuickCommandsMenu";

export interface PaneMoveTarget {
  id: string;
  label: string;
}

export interface LayoutMoveTarget {
  id: string;
  label: string;
  panes: PaneMoveTarget[];
}

interface TabContextMenuProps {
  tab: Tab;
  index: number;
  paneId: string;
  tabs: Tab[];
  /** 触发右键菜单的标签节点。 */
  children: React.ReactNode;
  startRename: (tab: Tab) => void;
  onClose: (tabId: string) => void;
  onTogglePin: (tabId: string) => void;
  onToggleStar: (tabId: string) => void;
  onSplitAndMoveRight: (tabId: string) => void;
  onSplitAndMoveDown: (tabId: string) => void;
  moveTargets: PaneMoveTarget[];
  onMoveTabToPane: (tabId: string, targetPaneId: string) => void;
  layoutMoveTargets: LayoutMoveTarget[];
  onMoveTabToLayoutPane: (tabId: string, targetLayoutId: string, targetPaneId: string) => void;
  onSplitTerminalRight: (tabId: string) => void;
  onSplitTerminalDown: (tabId: string) => void;
  onCloseTerminalPane: (tabId: string) => void;
  onCloseTabsToLeft: (tabId: string) => void;
  onCloseTabsToRight: (tabId: string) => void;
  onCloseOtherTabs: (tabId: string) => void;
  onRevealInExplorer?: (tab: Tab) => void;
  onPopOutTab?: (tabId: string) => void;
  onEditWorkspaceEnvironment?: (tab: Tab) => void;
  canEditWorkspaceEnvironment?: (tab: Tab) => boolean;
  onCloneTab?: (tab: Tab) => void;
  onToggleFullscreen?: (tabId: string) => void;
  isPaneFullscreen?: boolean;
  t: TFunction<"panes">;
}

export default function TabContextMenu({
  tab,
  index,
  paneId,
  tabs,
  children,
  startRename,
  onClose,
  onTogglePin,
  onToggleStar,
  onSplitAndMoveRight,
  onSplitAndMoveDown,
  moveTargets,
  onMoveTabToPane,
  layoutMoveTargets,
  onMoveTabToLayoutPane,
  onSplitTerminalRight,
  onSplitTerminalDown,
  onCloseTerminalPane,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onRevealInExplorer,
  onPopOutTab,
  onEditWorkspaceEnvironment,
  canEditWorkspaceEnvironment,
  onCloneTab,
  onToggleFullscreen,
  isPaneFullscreen,
  t,
}: TabContextMenuProps) {
  const terminalLeafCount =
    tab.contentType === "terminal" && tab.terminalRootPane
      ? countTerminalLeaves(tab.terminalRootPane)
      : 0;
  // 选 .length（原始值）而非数组引用：数组本体每次 push 都是新引用，但长度快照稳定。
  const closedTabCount = usePanesStore((s) => s.closedTabs.length);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={() => startRename(tab)}>
          <Pencil /> {t("renameTab")}
        </ContextMenuItem>
        <ContextMenuItem inset onClick={() => onTogglePin(tab.id)}>
          {tab.pinned ? t("unpinTab") : t("pinTab")}
        </ContextMenuItem>
        <ContextMenuItem inset onClick={() => onToggleStar(tab.id)}>
          {tab.starred ? t("unstarTab") : t("starTab")}
        </ContextMenuItem>
        {tab.contentType === "terminal" && tab.projectPath && onCloneTab && (
          <ContextMenuItem onClick={() => onCloneTab(tab)}>
            <CopyPlus /> {t("cloneTerminal")}
          </ContextMenuItem>
        )}
        {onToggleFullscreen && (
          <ContextMenuItem onClick={() => onToggleFullscreen(tab.id)}>
            {isPaneFullscreen ? <Minimize2 /> : <Maximize2 />}{" "}
            {isPaneFullscreen ? t("exitFullscreenTab") : t("enterFullscreenTab")}
          </ContextMenuItem>
        )}
        {tab.contentType === "terminal" && tab.sessionId && onPopOutTab && (
          <ContextMenuItem onClick={() => onPopOutTab(tab.id)}>
            <ExternalLink /> {t("popOutWindow")}
          </ContextMenuItem>
        )}
        {tab.contentType === "editor" && tab.filePath && onRevealInExplorer && (
          <ContextMenuItem onClick={() => onRevealInExplorer(tab)}>
            <FolderTree /> {t("revealInExplorer")}
          </ContextMenuItem>
        )}
        {/* 非终端 tab 此前只能沿用一套按终端做的菜单。浏览器复制 URL、文件复制
            路径是这两类最常用的动作，缺了就只能手抄地址栏。 */}
        {tab.contentType === "browser" && tab.browserUrl && (
          <ContextMenuItem onClick={() => void navigator.clipboard.writeText(tab.browserUrl!)}>
            <Copy /> {t("copyBrowserUrl")}
          </ContextMenuItem>
        )}
        {tab.contentType === "editor" && tab.filePath && (
          <ContextMenuItem onClick={() => void navigator.clipboard.writeText(tab.filePath!)}>
            <Copy /> {t("copyFilePath")}
          </ContextMenuItem>
        )}
        {onEditWorkspaceEnvironment && canEditWorkspaceEnvironment?.(tab) ? (
          <ContextMenuItem onClick={() => onEditWorkspaceEnvironment(tab)}>
            <Settings2 /> {t("editWorkspaceEnvironment")}
          </ContextMenuItem>
        ) : null}
        <TabQuickCommandsMenu tab={tab} paneId={paneId} />
        <ContextMenuSeparator />
        {/* 窗格级分屏走命令注册中心：菜单项自动显示当前键位，键位改绑后同步变。
            菜单文案保留「面板 · 拆分到右/下」，与终端格子分屏（下方 splitRight/splitDown）区分。 */}
        <CommandMenuItem commandId="split-right" ctx={{ paneId }} label={t("splitPanelRight")} />
        <CommandMenuItem commandId="split-down" ctx={{ paneId }} label={t("splitPanelDown")} />
        {tabs.length > 1 && (
          <>
            <ContextMenuItem onClick={() => onSplitAndMoveRight(tab.id)}>
              <PanelRight /> {t("splitAndMoveRight")}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onSplitAndMoveDown(tab.id)}>
              <PanelBottom /> {t("splitAndMoveDown")}
            </ContextMenuItem>
          </>
        )}
        {moveTargets.length > 0 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger inset>
              <Send /> {t("sendToPane")}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {moveTargets.map((target) => (
                <ContextMenuItem key={target.id} onClick={() => onMoveTabToPane(tab.id, target.id)}>
                  {target.label}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        {layoutMoveTargets.length > 0 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger inset>
              <Send /> {t("sendToLayout")}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-56">
              {layoutMoveTargets.map((layout) => {
                if (layout.panes.length === 1) {
                  const targetPane = layout.panes[0];
                  return (
                    <ContextMenuItem
                      key={layout.id}
                      onClick={() => onMoveTabToLayoutPane(tab.id, layout.id, targetPane.id)}
                    >
                      {layout.label}
                    </ContextMenuItem>
                  );
                }
                return (
                  <ContextMenuSub key={layout.id}>
                    <ContextMenuSubTrigger>{layout.label}</ContextMenuSubTrigger>
                    <ContextMenuSubContent className="w-56">
                      {layout.panes.map((targetPane) => (
                        <ContextMenuItem
                          key={targetPane.id}
                          onClick={() => onMoveTabToLayoutPane(tab.id, layout.id, targetPane.id)}
                        >
                          {targetPane.label}
                        </ContextMenuItem>
                      ))}
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                );
              })}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        {tab.contentType === "terminal" && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onSplitTerminalRight(tab.id)}>
              <PanelRight /> {t("splitRight")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onSplitTerminalDown(tab.id)}>
              <PanelBottom /> {t("splitDown")}
            </ContextMenuItem>
            <ContextMenuItem
              disabled={terminalLeafCount <= 1}
              onSelect={() => onCloseTerminalPane(tab.id)}
            >
              {t("closeTerminalPane")}
            </ContextMenuItem>
          </>
        )}
        {tabs.length > 1 && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              inset
              disabled={tabs.slice(0, index).filter((t) => !t.pinned).length === 0}
              onClick={() => onCloseTabsToLeft(tab.id)}
            >
              {t("closeTabsToLeft")}
            </ContextMenuItem>
            <ContextMenuItem
              inset
              disabled={tabs.slice(index + 1).filter((t) => !t.pinned).length === 0}
              onClick={() => onCloseTabsToRight(tab.id)}
            >
              {t("closeTabsToRight")}
            </ContextMenuItem>
            <ContextMenuItem
              inset
              disabled={tabs.filter((_, i) => i !== index && !tabs[i].pinned).length === 0}
              onClick={() => onCloseOtherTabs(tab.id)}
            >
              {t("closeOtherTabs")}
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        {!tab.pinned && (
          <ContextMenuItem variant="destructive" inset onClick={() => onClose(tab.id)}>
            {t("closeTab")}
          </ContextMenuItem>
        )}
        {/* 撤销误关：closedTabs 栈顶弹回本窗格（快照带 resumeId，可 resume 回原对话） */}
        <ContextMenuItem
          inset
          disabled={closedTabCount === 0}
          onClick={() => usePanesStore.getState().reopenClosedTab(paneId)}
        >
          {t("restoreClosedTabs", { count: closedTabCount })}
          <CommandShortcutHint commandId="reopen-closed-tab" />
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function countTerminalLeaves(node: NonNullable<Tab["terminalRootPane"]>): number {
  if (node.type === "leaf") return 1;
  return node.children.reduce((total, child) => total + countTerminalLeaves(child), 0);
}
