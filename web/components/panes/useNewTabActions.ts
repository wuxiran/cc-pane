// 标签栏「＋」下拉的三个非终端入口。
// 抽出来是为了把 Panel 从「什么都往里塞」拉回来——这三件事只跟新建 tab 有关，
// 与 Panel 的分屏/全屏/关闭逻辑没有交集。
import { useCallback } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { usePanesStore, useWorkspacesStore } from "@/stores";
import { useShallow } from "zustand/react/shallow";
import type { Tab } from "@/types";

export function useNewTabActions(paneId: string, activeTab: Tab | undefined) {
  const { openBrowser, openDsh, openEditor, openFileExplorer } = usePanesStore(
    useShallow((s) => ({
      openBrowser: s.openBrowser,
      openDsh: s.openDsh,
      openEditor: s.openEditor,
      openFileExplorer: s.openFileExplorer,
    })),
  );
  const projectPath = activeTab?.projectPath;

  // 浏览器 tab 桌面端此前无入口（只能靠 MCP open_browser_tab）。开在 about:blank，
  // 地址由 BrowserTabContent 自带的地址栏输入——不额外弹一个 URL 输入框。
  const handleAddBrowser = useCallback(() => {
    openBrowser("about:blank", undefined, undefined, { paneId, reuse: false });
  }, [paneId, openBrowser]);

  // dsh 进程用 projectPath 作默认工作空间根；没有也能开（落在继承的 cwd）。
  //
  // workspacePath 取**当前选中的工作空间**而不是 activeTab.workspacePath：
  // 后者只有部分终端标签带，从纯 shell / 浏览器 / 文件标签旁边点 ＋ 时取不到，
  // 于是所有实例都挤进共享的 "default"，工作区自动注册也随之整个跳过
  // （实测：日志只有 `workspace_key=default`，一次推送都没发起）。
  //
  // 在回调里 getState() 而不是进 selector：`selectedWorkspace()` 每次返回新对象，
  // 放进 selector 会让 useSyncExternalStore 的快照永不相等 → 崩页
  // （CLAUDE.md 已记这条）。同样写法的先例见 useWallpaperStore / FileBrowserView。
  const handleAddDsh = useCallback(() => {
    const workspacePath = useWorkspacesStore.getState().selectedWorkspace()?.path;
    openDsh(projectPath || undefined, workspacePath || undefined, { paneId });
  }, [paneId, projectPath, openDsh]);

  const handleAddFile = useCallback(async () => {
    const picked = await openFileDialog({
      multiple: false,
      directory: false,
      defaultPath: projectPath || undefined,
    });
    if (typeof picked !== "string") return;
    const title = picked.split(/[\\/]/).pop() || picked;
    // forcePaneTab：用户是从分屏区的 ＋ 点进来的，期望文件落在**这个** pane；
    // 不加这个标志时，若 appViewMode 恰好是 files，openEditor 会改走 Files 视图
    // 的 tab 列表并返回 null，分屏区完全没反应（看着像点了没用）。
    openEditor(projectPath || "", picked, title, undefined, { forcePaneTab: true });
  }, [projectPath, openEditor]);

  const handleAddFileExplorer = useCallback(() => {
    if (!projectPath) return;
    const title = projectPath.split(/[\\/]/).filter(Boolean).pop() || projectPath;
    openFileExplorer(projectPath, title);
  }, [projectPath, openFileExplorer]);

  return {
    handleAddBrowser,
    handleAddDsh,
    handleAddFile,
    // 没有项目路径就没有目录树可开，交给调用方决定要不要显示该菜单项
    handleAddFileExplorer: projectPath ? handleAddFileExplorer : undefined,
  };
}
