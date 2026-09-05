// 深埋功能命令（批 6 可发现性）：截图 / 本地历史 / worktree / Git 时间线 / 会话清理，
// 此前只藏在全局热键或侧栏项目右键三级位置；命令面板（Ctrl+K）现在可以直接搜到。
import {
  Camera,
  GitBranch,
  GitCommitHorizontal,
  History,
  Keyboard,
  Trash2,
} from "lucide-react";
import { handleErrorSilent } from "@/utils/errorHandler";
import { useDialogStore } from "@/stores";
import { SHORTCUT_CHEATSHEET_TOGGLE_EVENT } from "@/components/ShortcutCheatsheet";
import { screenshotService } from "@/services/screenshotService";
import { isTauriRuntime } from "@/services/runtime";
import type { CommandDescriptor } from "./types";
import { resolvePaneTab } from "./resolveTarget";

function activeProjectPath(): string | null {
  return resolvePaneTab({})?.tab.projectPath ?? null;
}

export function buildDeepFeatureCommands(): CommandDescriptor[] {
  return [
    {
      id: "shortcut-cheatsheet",
      titleKey: "shortcut-cheatsheet",
      icon: Keyboard,
      group: "system",
      run: () => {
        window.dispatchEvent(new Event(SHORTCUT_CHEATSHEET_TOGGLE_EVENT));
      },
    },
    {
      // 截图此前是纯全局热键功能，零 UI 入口
      id: "screenshot-capture",
      titleKey: "screenshot-capture",
      icon: Camera,
      group: "system",
      when: () => isTauriRuntime(),
      run: () => {
        void screenshotService.trigger().catch((error) => handleErrorSilent(error, "trigger screenshot"));
      },
    },
    {
      // 本地历史此前只藏在项目右键菜单里；按当前标签的项目打开
      id: "local-history",
      titleKey: "local-history",
      icon: History,
      group: "system",
      when: () => Boolean(activeProjectPath()),
      run: () => {
        const path = activeProjectPath();
        if (path) useDialogStore.getState().openLocalHistory(path);
      },
    },
    {
      id: "worktree-manager",
      titleKey: "worktree-manager",
      icon: GitBranch,
      group: "system",
      when: () => Boolean(activeProjectPath()),
      run: () => {
        const path = activeProjectPath();
        if (path) useDialogStore.getState().requestWorktreeManager(path);
      },
    },
    {
      id: "git-timeline",
      titleKey: "git-timeline",
      icon: GitCommitHorizontal,
      group: "system",
      when: () => Boolean(activeProjectPath()),
      run: () => {
        const path = activeProjectPath();
        if (path) useDialogStore.getState().openGitTimeline(path);
      },
    },
    {
      id: "session-cleaner",
      titleKey: "session-cleaner",
      icon: Trash2,
      group: "system",
      when: () => Boolean(activeProjectPath()),
      run: () => {
        const path = activeProjectPath();
        if (path) useDialogStore.getState().openSessionCleaner(path);
      },
    },
  ];
}
