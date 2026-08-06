// 分屏区 editor 标签的打开 / 关闭 / 枚举。
//
// 从 usePanesStore.ts 拆出（该文件已触到行数棘轮上限，见 web/test/lineRatchet.test.ts），
// 与 browserTabActions.ts 同一套路：只依赖 store 的 set/get 与布局辅助层。
import type { PaneNode, Panel, Tab } from "@/types";
import type { PanesDraft, PanesState, TabAcrossLayoutsLocation } from "./panesStoreTypes";
import {
  eachLayoutTree,
  resolveLayoutWriteTarget,
} from "./paneLayoutHelpers";
import { collectPanels, findPane, generateId } from "@/lib/paneTree";
import { useActivityBarStore } from "./useActivityBarStore";
import { useEditorTabsStore } from "./useEditorTabsStore";

export interface EditorTabFileInfo {
  filePath: string;
  projectPath: string;
  title: string;
  dirty: boolean;
  pinned: boolean;
  active: boolean;
}

export interface EditorTabActions {
  openEditor: (
    projectPath: string,
    filePath: string,
    title: string,
    layoutId?: string,
    options?: { forcePaneTab?: boolean },
  ) => string | null;
  closeEditorTabsByPath: (filePath: string) => void;
  listEditorTabsAcrossLayouts: () => EditorTabFileInfo[];
}

/** 跨全部布局按 filePath 找 editor tab（分屏区文件去重/关闭/查询共用） */
export function findEditorTabByPathAcrossLayouts(
  state: PanesState,
  filePath: string,
): TabAcrossLayoutsLocation | null {
  let found: TabAcrossLayoutsLocation | null = null;
  eachLayoutTree(state, (layout, tree: PaneNode) => {
    if (found) return;
    for (const panel of collectPanels(tree)) {
      const tab = panel.tabs.find(
        (item: Tab) => item.contentType === "editor" && item.filePath === filePath,
      );
      if (tab) {
        found = { layoutId: layout.id, layoutName: layout.name, tree, panel, tab };
        return;
      }
    }
  });
  return found;
}

interface EditorHostStore extends PanesState {
  selectTab: (paneId: string, tabId: string) => void;
  switchLayout: (layoutId: string) => void;
}

export function createEditorTabActions(
  set: (recipe: (state: PanesDraft) => void) => void,
  get: () => EditorHostStore,
): EditorTabActions {
  return {
    openEditor: (projectPath, filePath, title, layoutId, options) => {
      // Files 视图不渲染分屏区：留在该视图的编辑面板内打开
      // （useEditorTabsStore.openFile 自带去重与 recentFiles 登记）。
      //
      // forcePaneTab 是给「分屏区里的新建入口」用的逃生阀：用户从 TabBar 的 ＋
      // 点「打开文件」时，期望文件出现在**这个 pane** 里；若恰好 appViewMode 还
      // 是 files，走上面那条岔路会返回 null、分屏区毫无反应——看着像点了没用。
      const activity = useActivityBarStore.getState();
      if (activity.appViewMode === "files" && !options?.forcePaneTab) {
        useEditorTabsStore.getState().openFile(projectPath, filePath, title);
        return null;
      }

      // 分屏区路径也要登记最近文件（RecentFilesPicker 数据源在 useEditorTabsStore）
      useEditorTabsStore
        .getState()
        .addRecent({ filePath, projectPath, title, openedAt: Date.now() });

      // 目标布局：调用方指定且确实存在才认，否则当前布局。
      const requestedLayout = layoutId
        ? get().listLayouts().find((layout) => layout.id === layoutId)
        : undefined;
      // 不传 layoutId = 用户在 UI 里点开的，视图跟着走（老行为）；
      // 传了 = MCP 调用方指定落点，不许把用户从正在看的画面拽走。
      const followView = !layoutId;

      // 跨全部布局按 filePath 去重：同一文件双缓冲编辑会互相覆盖，聚焦已有 tab。
      const found = findEditorTabByPathAcrossLayouts(get(), filePath);
      const targetLayoutId = found?.layoutId ?? requestedLayout?.id ?? get().currentLayoutId;

      // home/todo/providers 等视图看不到分屏区：落点在用户眼前（或视图跟着走）才切回 panes，
      // 否则切过去也看不见这次打开。
      if (
        (followView || targetLayoutId === get().currentLayoutId) &&
        activity.appViewMode !== "panes"
      ) {
        activity.setAppViewMode("panes");
      }

      if (found) {
        if (followView && found.layoutId !== get().currentLayoutId) {
          get().switchLayout(found.layoutId);
        }
        if (found.layoutId === get().currentLayoutId) {
          get().selectTab(found.panel.id, found.tab.id);
        } else {
          // 目标在别的布局：原地聚焦，由调用方决定要不要提示「去看看」
          set((state) => {
            const target = resolveLayoutWriteTarget(state, found.layoutId);
            if (!target) return;
            const panel = findPane(target.tree, found.panel.id);
            if (panel?.type !== "panel") return;
            panel.activeTabId = found.tab.id;
            target.setActivePaneId(panel.id);
          });
        }
        return found.layoutId;
      }

      set((state) => {
        const target = resolveLayoutWriteTarget(state, targetLayoutId);
        if (!target) return;
        const fallbackPaneId = target.isCurrent ? state.activePaneId : "";
        const basePane = findPane(target.tree, fallbackPaneId);
        const pane = basePane?.type === "panel" ? basePane : collectPanels(target.tree)[0];
        if (pane?.type !== "panel") return;
        const newTab: Tab = {
          id: generateId("tab"),
          title,
          contentType: "editor",
          projectId: "",
          projectPath,
          sessionId: null,
          filePath,
        };
        pane.tabs.push(newTab);
        pane.activeTabId = newTab.id;
        // 非当前布局：把落点记进该布局的 activePaneId，用户切过去就能看到这个文件
        if (!target.isCurrent) target.setActivePaneId(pane.id);
      });
      return targetLayoutId;
    },

    closeEditorTabsByPath: (filePath) => {
      // 两条路径合一。改道前当前布局走 closeTab、其他布局裸 splice
      // 绕过一切语义（activeTabId 收敛口径都不同）——现在统一交给唯一销毁出口。
      //
      // reason=editor-path-close：不可否决（MCP 说文件已关，就是已关，不该弹框
      // 拦住自动化流程）、无 PTY 可回收、不记撤销栈。星标布局维持跳过。
      const state = get();
      const tabIds: string[] = [];
      eachLayoutTree(state, (_layout, tree: PaneNode) => {
        for (const panel of collectPanels(tree)) {
          for (const tab of panel.tabs) {
            if (tab.contentType === "editor" && tab.filePath === filePath) {
              tabIds.push(tab.id);
            }
          }
        }
      });
      if (tabIds.length > 0) get().removeTabsInternal(tabIds, "editor-path-close");
    },

    listEditorTabsAcrossLayouts: () => {
      const state = get();
      const result: EditorTabFileInfo[] = [];
      eachLayoutTree(state, (layout, tree: PaneNode) => {
        for (const panel of collectPanels(tree) as Panel[]) {
          for (const t of panel.tabs) {
            if (t.contentType !== "editor" || !t.filePath) continue;
            result.push({
              filePath: t.filePath,
              projectPath: t.projectPath,
              title: t.title,
              dirty: t.dirty ?? false,
              pinned: t.pinned ?? false,
              active:
                layout.id === state.currentLayoutId &&
                panel.activeTabId === t.id &&
                state.activePaneId === panel.id,
            });
          }
        }
      });
      return result;
    },
  };
}
