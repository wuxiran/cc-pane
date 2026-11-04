import "@/i18n/tabContextMenuResources";
import { Suspense, useState } from "react";
import { lazyWithRetry } from "@/lib/lazyRetry";
import { terminalForkSource } from "@/services/chatForkService";
// tab 右键菜单：从 TabBar 拆出（行数棘轮约束），行为与外观保持不变。
// 新增「恢复已关闭标签」入口直接读 usePanesStore（与 TabQuickCommandsMenu 直读 store 同形态），
// 避免 Panel → TabBar → 此处的三层 props 透传。
import {
  Copy,
  CopyPlus,
  GitFork,
  FileDiff,
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
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { usePanesStore } from "@/stores";
import type { Tab } from "@/types";
import type { TFunction } from "i18next";
import CommandMenuItem from "@/components/commands/CommandMenuItem";
import RestoreClosedTabsMenu from "./RestoreClosedTabsMenu";
import TabQuickCommandsMenu from "./TabQuickCommandsMenu";
import { handleError } from "@/utils/errorHandler";
import CodexMenuItems from "@/components/agentchat/CodexMenuItems";

const ChatForkDialog = lazyWithRetry(() => import("@/components/chatfork/ChatForkDialog"), "ChatForkDialog");
const ForkReviewDialog = lazyWithRetry(() => import("@/components/chatfork/ForkReviewDialog"), "ForkReviewDialog");
const WorkbenchTabMenuItems = lazyWithRetry(() => import("./WorkbenchTabMenuItems"), "WorkbenchTabMenuItems");
const CodexHandoffDialog = lazyWithRetry(() => import("@/components/agentchat/CodexHandoffDialog"), "CodexHandoffDialog");


export interface PaneMoveTarget {
  id: string;
  label: string;
}

export interface LayoutMoveTarget {
  id: string;
  label: string;
  panes: PaneMoveTarget[];
}

export interface TabContextMenuProps {
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

export default function TabContextMenuContent({
  tab,
  index,
  paneId,
  tabs,
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
  menuOpen,
}: TabContextMenuProps & { menuOpen: boolean }) {
  const [forkOpen, setForkOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [handoffCwd, setHandoffCwd] = useState<string | null>(null);
  const forkSource = terminalForkSource(tab);
  const terminalLeafCount =
    tab.contentType === "terminal" && tab.terminalRootPane
      ? countTerminalLeaves(tab.terminalRootPane)
      : 0;

  return (
    <>
    {handoffCwd && <Suspense fallback={null}><CodexHandoffDialog cwd={handoffCwd} chatId={tab.contentType === "agent-chat" ? tab.id : undefined} onClose={() => setHandoffCwd(null)} /></Suspense>}
    {forkOpen && <Suspense fallback={null}><ChatForkDialog open={forkOpen} onOpenChange={setForkOpen} allowWorktree={!forkSource?.wsl} onFork={async (mode) => {
      const { buildTerminalFork } = await import("@/services/chatForkLaunch");
      const options = await buildTerminalFork(tab, mode);
      usePanesStore.getState().addTab(paneId, options);
    }} /></Suspense>}
    {reviewOpen && <Suspense fallback={null}><ForkReviewDialog open={reviewOpen} onOpenChange={setReviewOpen} forkReviewId={tab.forkReviewId} cwd={tab.projectPath} sourceSessionId={forkSource?.resumeId} /></Suspense>}
      <ContextMenuContent className="w-60 rounded-2xl p-1.5">
        {menuOpen && <Suspense fallback={null}><WorkbenchTabMenuItems tab={tab} paneId={paneId} section="browser" /></Suspense>}
        {menuOpen && <CodexMenuItems tab={tab} onHandoff={setHandoffCwd} />}
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
        {forkSource && !forkSource.ssh && (
          <ContextMenuItem onClick={() => setForkOpen(true)}><GitFork /> {t("forkChat")}</ContextMenuItem>
        )}
        {(tab.forkReviewId || (forkSource && !forkSource.ssh && !forkSource.wsl)) && <ContextMenuItem onClick={() => setReviewOpen(true)}><FileDiff /> {t("forkReviewTitle", { defaultValue: "Compare fork results" })}</ContextMenuItem>}
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
        {tab.contentType === "editor" && tab.filePath && (
          <ContextMenuItem onClick={() => { void Promise.resolve().then(() => navigator.clipboard.writeText(tab.filePath!)).catch((error) => handleError(error, "copy file path")); }}>
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
        {menuOpen && <Suspense fallback={null}><WorkbenchTabMenuItems tab={tab} paneId={paneId} section="move" /></Suspense>}
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
            <ContextMenuSubTrigger>
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
            <ContextMenuSubTrigger>
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
        {/* 撤销误关：恢复到本窗格（快照带 resumeId，可 resume 回原对话） */}
        <RestoreClosedTabsMenu paneId={paneId} />
      </ContextMenuContent>
    </>
  );
}

function countTerminalLeaves(node: NonNullable<Tab["terminalRootPane"]>): number {
  if (node.type === "leaf") return 1;
  return node.children.reduce((total, child) => total + countTerminalLeaves(child), 0);
}
