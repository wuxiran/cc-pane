// 「黄金五分钟」清单的真实完成度：设置页清单与首页「快速上手」共用。
// 进度反推逻辑 / ONBOARDING_PROGRESS_EVENT / localStorage key 是持久化契约，不改。
import { useEffect, useMemo, useState } from "react";
import { skillService } from "@/services/skillService";
import {
  useActivityBarStore,
  useDialogStore,
  useOrchestratorStore,
  useWorkspacesStore,
} from "@/stores";
import { MODULE_REGISTRY } from "@/modules/registry";
import {
  ONBOARDING_MULTI_LAUNCH_KEY,
  ONBOARDING_PROGRESS_EVENT,
} from "./setupGuideProgress";

export type SetupGuideItemId = "workspace" | "project" | "multiLaunch" | "dispatch" | "skill";

export interface SetupGuideItem {
  id: SetupGuideItemId;
  complete: boolean;
  action: () => void;
  guidePath: string;
}

export interface SetupGuideState {
  items: SetupGuideItem[];
  completed: number;
  /** 第一个未完成项（清单有先后语义）；全部完成时为 null。 */
  nextItem: SetupGuideItem | null;
  skillCheckFailed: boolean;
}

function readMultiLaunch(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(ONBOARDING_MULTI_LAUNCH_KEY) === "true";
  } catch {
    return false;
  }
}

export function openExplorer(): void {
  useDialogStore.getState().closeSettings();
  const activity = useActivityBarStore.getState();
  activity.setAppViewMode("panes");
  const next = useActivityBarStore.getState();
  if (next.activeView !== "explorer" || !next.sidebarVisible) {
    next.toggleView("explorer");
  }
}

export function openOnboarding(): void {
  const dialogs = useDialogStore.getState();
  dialogs.closeSettings();
  dialogs.openOnboarding();
}

function openOrchestration(): void {
  useDialogStore.getState().closeSettings();
  MODULE_REGISTRY.find((module) => module.id === "orchestration")?.open("rightDock");
}

// 资源中心已并入设置（a6db22b），Skills 入口现挂在 设置 → 工具 → Skills
export function openSkills(): void {
  useDialogStore.getState().openSettings();
}

export function useSetupGuideItems(): SetupGuideState {
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const bindings = useOrchestratorStore((state) => state.bindings);
  const [multiLaunch, setMultiLaunch] = useState(readMultiLaunch);
  const [installedSkillCount, setInstalledSkillCount] = useState<number | null>(null);
  const [skillCheckFailed, setSkillCheckFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      setMultiLaunch(readMultiLaunch());
      skillService.listUserSkills()
        .then((skills) => {
          if (cancelled) return;
          setInstalledSkillCount(skills.length);
          setSkillCheckFailed(false);
        })
        .catch(() => {
          if (cancelled) return;
          setInstalledSkillCount(0);
          setSkillCheckFailed(true);
        });
    };
    refresh();
    window.addEventListener(ONBOARDING_PROGRESS_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener(ONBOARDING_PROGRESS_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const items = useMemo<SetupGuideItem[]>(() => {
    const hasWorkspace = workspaces.length > 0;
    const hasProject = workspaces.some((workspace) => workspace.projects.length > 0);
    const hasDispatch = bindings.some((binding) =>
      binding.role === "worker"
      || (binding.role === "task" && Boolean(binding.sessionId)),
    );
    return [
      { id: "workspace", complete: hasWorkspace, action: openExplorer, guidePath: "docs/guide/03-core-concepts.md" },
      { id: "project", complete: hasProject, action: openExplorer, guidePath: "docs/guide/04-getting-started-5-steps.md" },
      { id: "multiLaunch", complete: multiLaunch, action: openOnboarding, guidePath: "docs/guide/05-terminal-and-panes.md" },
      { id: "dispatch", complete: hasDispatch, action: openOrchestration, guidePath: "docs/guide/12-leader-worker.md" },
      { id: "skill", complete: (installedSkillCount ?? 0) > 0, action: openSkills, guidePath: "docs/guide/18-skills.md" },
    ];
  }, [bindings, installedSkillCount, multiLaunch, workspaces]);

  const completed = items.filter((item) => item.complete).length;
  const nextItem = items.find((item) => !item.complete) ?? null;
  return { items, completed, nextItem, skillCheckFailed };
}
