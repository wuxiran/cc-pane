import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, CheckCircle2, Circle, GraduationCap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { skillService } from "@/services/skillService";
import {
  useActivityBarStore,
  useDialogStore,
  useOrchestratorStore,
  useWorkspacesStore,
} from "@/stores";
import { MODULE_REGISTRY } from "@/modules/registry";
import { cn } from "@/lib/utils";
import {
  ONBOARDING_MULTI_LAUNCH_KEY,
  ONBOARDING_PROGRESS_EVENT,
} from "./setupGuideProgress";

export { ONBOARDING_MULTI_LAUNCH_KEY } from "./setupGuideProgress";

type ChecklistItemId = "workspace" | "project" | "multiLaunch" | "dispatch" | "skill";

interface SetupGuideChecklistProps {
  variant?: "settings" | "home";
}

interface ChecklistItem {
  id: ChecklistItemId;
  complete: boolean;
  action: () => void;
}

function readMultiLaunch(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(ONBOARDING_MULTI_LAUNCH_KEY) === "true";
  } catch {
    return false;
  }
}

function openExplorer(): void {
  useDialogStore.getState().closeSettings();
  const activity = useActivityBarStore.getState();
  activity.setAppViewMode("panes");
  const next = useActivityBarStore.getState();
  if (next.activeView !== "explorer" || !next.sidebarVisible) {
    next.toggleView("explorer");
  }
}

function openOnboarding(): void {
  const dialogs = useDialogStore.getState();
  dialogs.closeSettings();
  dialogs.openOnboarding();
}

function openOrchestration(): void {
  useDialogStore.getState().closeSettings();
  MODULE_REGISTRY.find((module) => module.id === "orchestration")?.open("rightDock");
}

function openSkills(): void {
  useDialogStore.getState().closeSettings();
  useActivityBarStore.getState().setAppViewMode("resources");
}

export default function SetupGuideChecklist({
  variant = "settings",
}: SetupGuideChecklistProps) {
  const { t } = useTranslation("onboarding");
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

  const items = useMemo<ChecklistItem[]>(() => {
    const hasWorkspace = workspaces.length > 0;
    const hasProject = workspaces.some((workspace) => workspace.projects.length > 0);
    const hasDispatch = bindings.some((binding) =>
      binding.role === "worker"
      || (binding.role === "task" && Boolean(binding.sessionId)),
    );
    return [
      { id: "workspace", complete: hasWorkspace, action: openExplorer },
      { id: "project", complete: hasProject, action: openExplorer },
      { id: "multiLaunch", complete: multiLaunch, action: openOnboarding },
      { id: "dispatch", complete: hasDispatch, action: openOrchestration },
      { id: "skill", complete: (installedSkillCount ?? 0) > 0, action: openSkills },
    ];
  }, [bindings, installedSkillCount, multiLaunch, workspaces]);

  const completed = items.filter((item) => item.complete).length;
  const progress = Math.round((completed / items.length) * 100);
  const Heading = variant === "home" ? "h3" : "h2";

  return (
    <section
      className={cn(
        "min-w-0",
        variant === "home"
          && "rounded-lg border border-[var(--app-home-border)] bg-[var(--app-home-surface)] p-5",
      )}
      data-testid={variant === "home" ? "getting-started" : "setup-guide-checklist"}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Heading className="text-base font-semibold text-[var(--app-text-primary)]">
            {t("setupGuide.title")}
          </Heading>
          <p className="mt-1 text-xs leading-relaxed text-[var(--app-text-tertiary)]">
            {t("setupGuide.description")}
          </p>
        </div>
        <span className="shrink-0 text-xs font-medium text-[var(--app-accent)]">
          {t("setupGuide.progress", { completed, total: items.length })}
        </span>
      </div>

      <div
        className="mt-4 h-1.5 overflow-hidden rounded-full bg-[var(--app-hover)]"
        role="progressbar"
        aria-label={t("setupGuide.progressLabel")}
        aria-valuemin={0}
        aria-valuemax={items.length}
        aria-valuenow={completed}
      >
        <div
          className="h-full rounded-full bg-[var(--app-accent)] transition-[width] duration-[var(--dur)]"
          style={{ width: `${progress}%` }}
        />
      </div>

      <ol className="mt-4 divide-y divide-[var(--app-border)] border-y border-[var(--app-border)]">
        {items.map((item) => {
          const descriptionKey = item.id === "skill" && skillCheckFailed
            ? "setupGuide.items.skill.checkFailed"
            : `setupGuide.items.${item.id}.description`;
          return (
            <li key={item.id} className="flex flex-wrap items-center gap-3 py-3">
              {item.complete ? (
                <CheckCircle2 className="size-4 shrink-0 text-[var(--app-status-success)]" aria-hidden="true" />
              ) : (
                <Circle className="size-4 shrink-0 text-[var(--app-text-tertiary)]" aria-hidden="true" />
              )}
              <div className="min-w-[180px] flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-medium text-[var(--app-text-primary)]">
                    {t(`setupGuide.items.${item.id}.title`)}
                  </span>
                  <span className={cn(
                    "text-[11px]",
                    item.complete
                      ? "text-[var(--app-status-success)]"
                      : "text-[var(--app-text-tertiary)]",
                  )}>
                    {t(item.complete ? "setupGuide.completed" : "setupGuide.pending")}
                  </span>
                </div>
                <p className="mt-0.5 text-xs leading-relaxed text-[var(--app-text-secondary)]">
                  {t(descriptionKey as never)}
                </p>
              </div>
              <Button type="button" variant="ghost" size="sm" className="gap-1.5" onClick={item.action}>
                {t(`setupGuide.items.${item.id}.action`)}
                <ArrowRight className="size-3.5" aria-hidden="true" />
              </Button>
            </li>
          );
        })}
      </ol>

      <Button
        type="button"
        variant="link"
        size="sm"
        className="mt-3 h-auto gap-1.5 px-0"
        onClick={openOnboarding}
      >
        <GraduationCap className="size-4" aria-hidden="true" />
        {t("setupGuide.replay")}
      </Button>
    </section>
  );
}
