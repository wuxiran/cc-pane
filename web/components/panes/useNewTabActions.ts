import { useCallback, useRef } from "react";
import { usePanesStore, useWorkspacesStore } from "@/stores";
import { useShallow } from "zustand/react/shallow";
import { handleError } from "@/utils";
import type { Tab } from "@/types";

/** Shared by the tab menu and the new-tab page, with explicit pane placement. */
export function useNewTabActions(paneId: string, activeTab: Tab | undefined) {
  const { openBrowser, openDsh, openAgentChat, addTab } = usePanesStore(
    useShallow((s) => ({ openBrowser: s.openBrowser, openDsh: s.openDsh, openAgentChat: s.openAgentChat,
      addTab: s.addTab })),
  );
  // Return a primitive so the selector remains stable when no project is selected.
  const workspaceProject = useWorkspacesStore((s) => s.selectedProject()?.path || s.selectedWorkspace()?.path || "");
  const projectPath = activeTab?.projectPath || workspaceProject;
  const layoutId = usePanesStore((s) => (activeTab ? s.findTabAcrossLayouts(activeTab.id)?.layoutId : undefined) ?? s.currentLayoutId);
  const creatingPage = useRef(false);

  const handleAddBrowser = useCallback(() => {
    openBrowser("about:blank", undefined, undefined, { paneId, layoutId, reuse: false, projectPath: projectPath || undefined });
  }, [paneId, layoutId, openBrowser, projectPath]);

  const handleAddTerminal = useCallback(() => {
    addTab(paneId, { projectId: "", projectPath, cliTool: "none" }, layoutId);
  }, [addTab, paneId, projectPath, layoutId]);

  const handleAddDsh = useCallback(() => {
    const workspacePath = useWorkspacesStore.getState().selectedWorkspace()?.path;
    openDsh(projectPath || undefined, workspacePath || undefined, { paneId });
  }, [paneId, projectPath, openDsh]);

  const handleAddAgentChat = useCallback(() => {
    openAgentChat(projectPath || undefined, { paneId });
  }, [paneId, projectPath, openAgentChat]);

  const handleAddFile = useCallback(async () => {
    try {
      const { openNewTabFile } = await import("./newTabFileActions");
      await openNewTabFile({ paneId, projectPath, layoutId });
    } catch (cause) { handleError(cause, "open file"); }
  }, [paneId, projectPath, layoutId]);

  const handleAddFileExplorer = useCallback(async () => {
    try {
      const { openNewTabDirectory } = await import("./newTabFileActions");
      await openNewTabDirectory({ paneId, projectPath, layoutId });
    } catch (cause) { handleError(cause, "open directory"); }
  }, [paneId, projectPath, layoutId]);

  const handleCreatePage = useCallback(async () => {
    if (creatingPage.current) return;
    creatingPage.current = true;
    try {
      const { createNewTabPage } = await import("./newTabFileActions");
      await createNewTabPage({ paneId, projectPath, layoutId });
    } catch (cause) { handleError(cause, "create Markdown page"); }
    finally { creatingPage.current = false; }
  }, [projectPath, paneId, layoutId]);

  const handleAddReview = useCallback(async () => {
    try {
      const { openNewTabReview } = await import("./newTabFileActions");
      await openNewTabReview({ paneId, projectPath, layoutId });
    } catch (cause) { handleError(cause, "open review"); }
  }, [paneId, projectPath, layoutId]);

  return { projectPath, handleAddBrowser, handleAddTerminal, handleAddDsh, handleAddAgentChat,
    handleAddFile, handleAddFileExplorer, handleAddReview, handleCreatePage };
}
