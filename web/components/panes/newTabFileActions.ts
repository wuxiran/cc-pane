import { open, save } from "@tauri-apps/plugin-dialog";
import { usePanesStore } from "@/stores/usePanesStore";
import { filesystemService } from "@/services/filesystemService";
import { parentNavigationPath } from "@/utils/path";

interface NewTabTarget { paneId: string; projectPath: string; layoutId: string }
const titleOf = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path;
const chooseProject = async (target: NewTabTarget) => {
  if (target.projectPath) return target.projectPath;
  const path = await open({ multiple: false, directory: true });
  return typeof path === "string" ? path : null;
};

export async function openNewTabFile(target: NewTabTarget) {
  const path = await open({ multiple: false, directory: false, defaultPath: target.projectPath || undefined });
  if (typeof path !== "string") return;
  usePanesStore.getState().openEditor(target.projectPath || parentNavigationPath(path, "auto") || "", path,
    titleOf(path), target.layoutId, { forcePaneTab: true, paneId: target.paneId });
}

export async function openNewTabDirectory(target: NewTabTarget) {
  const path = await chooseProject(target);
  if (path) usePanesStore.getState().openFileExplorer(path, titleOf(path), { paneId: target.paneId, layoutId: target.layoutId });
}

export async function openNewTabReview(target: NewTabTarget) {
  const path = await chooseProject(target);
  if (path) usePanesStore.getState().openReviewTab(path, { paneId: target.paneId, layoutId: target.layoutId });
}

export async function createNewTabPage(target: NewTabTarget) {
  const picked = await save({
    defaultPath: target.projectPath ? `${target.projectPath.replace(/[\\/]+$/, "")}/Untitled.md` : "Untitled.md",
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (!picked) return;
  const path = /\.md$/i.test(picked) ? picked : `${picked}.md`;
  await filesystemService.createFile(path);
  usePanesStore.getState().openEditor(target.projectPath || parentNavigationPath(path, "auto") || "", path,
    titleOf(path), target.layoutId, { forcePaneTab: true, paneId: target.paneId });
}
