import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { useFileBrowserStore } from "@/stores/useFileBrowserStore";
import { useEditorTabsStore } from "@/stores/useEditorTabsStore";

interface CcPanesApi {
  openFileBrowser: (path: string) => void;
  openFile: (projectPath: string, filePath: string) => void;
}

declare global {
  interface Window {
    __ccPanes?: CcPanesApi;
  }
}

export function registerGlobalApi(): void {
  window.__ccPanes = {
    openFileBrowser: (path: string) => {
      useFileBrowserStore.getState().navigateTo(path);
      const state = useActivityBarStore.getState();
      if (state.appViewMode !== "files") {
        state.toggleFilesMode();
      }
    },
    openFile: (projectPath: string, filePath: string) => {
      const fileName = filePath.split(/[/\\]/).pop() || "File";
      useEditorTabsStore.getState().openFile(projectPath, filePath, fileName);
      const state = useActivityBarStore.getState();
      if (state.appViewMode !== "files") {
        state.toggleFilesMode();
      }
    },
  };
}
