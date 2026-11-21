// 启动器「高级」参数按 CLI 记住上次的值（本机 UI 偏好，不进设置/后端）。
// 只记跨次启动有意义的开关；系统提示、场景模板、worktree、布局等一次性内容不记。
import type { CliTool, LaunchEffort } from "@/types";
import type { LauncherDraft } from "./launcherModel";

const STORAGE_KEY = "cc-panes.launcher.cliPrefs.v1";

export type LauncherCliPrefs = Pick<LauncherDraft, "yolo" | "effort" | "verbose" | "skipMcp" | "maxTurns">;

type PrefsMap = Partial<Record<CliTool, LauncherCliPrefs>>;

function readAll(): PrefsMap {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as PrefsMap) : {};
  } catch {
    return {};
  }
}

/** 取某 CLI 记住的参数；没有记录时返回各项默认值（切 CLI 时要把上一个 CLI 的值清掉）。 */
export function loadCliPrefs(cliTool: CliTool): LauncherCliPrefs {
  const saved: Partial<LauncherCliPrefs> = readAll()[cliTool] ?? {};
  const effort = typeof saved.effort === "string" ? (saved.effort as LaunchEffort) : undefined;
  const maxTurns = typeof saved.maxTurns === "number" && saved.maxTurns > 0 ? saved.maxTurns : undefined;
  return {
    yolo: saved.yolo === true ? true : undefined,
    effort,
    verbose: saved.verbose === true,
    skipMcp: saved.skipMcp === true,
    maxTurns,
  };
}

export function saveCliPrefs(draft: LauncherDraft): void {
  if (draft.cliTool === "none") return;
  try {
    const all = readAll();
    all[draft.cliTool] = {
      yolo: draft.yolo,
      effort: draft.effort,
      verbose: draft.verbose,
      skipMcp: draft.skipMcp,
      maxTurns: draft.maxTurns,
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* 存不下只是下次不记得 */
  }
}
