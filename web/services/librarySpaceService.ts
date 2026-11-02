import { invoke } from "@tauri-apps/api/core";

/** 资料空间（docs/108）：模板铺设结果。`kept` 为已存在、未覆盖的模板文件。 */
export interface LibraryScaffold {
  root: string;
  written: string[];
  kept: string[];
}

export interface LibrarySpace {
  root: string;
  workspaceName: string;
  createdWorkspace: boolean;
  scaffold: LibraryScaffold;
}

/** 铺模板 + 建工作空间 + 登记项目；`path` 为空时用 `~/CC-Panes-Library`。仅桌面端可用。 */
export function createLibrarySpace(workspaceName: string, path?: string | null): Promise<LibrarySpace> {
  return invoke<LibrarySpace>("create_library_space", { workspaceName, path: path || null });
}
