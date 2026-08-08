// 黄金五分钟旅程条：进度环 + 五节点轨道 + 聚焦「下一步」行动卡。
// 任何时刻只有一个主 CTA：0/5 时是「开始新手教程」，进行中是聚焦卡的行动按钮，
// 5/5 后整卡收束成一条 success 横条让出主页主位。
// 进度反推逻辑 / ONBOARDING_PROGRESS_EVENT / localStorage key / data-testid 是持久化契约，不改。
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, BadgeCheck, GraduationCap, Play } from "lucide-react";
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
import AgentConciergeEntry from "./AgentConciergeEntry";
import { openGuideDoc } from "@/components/tips/openGuideDoc";
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
  guidePath: string;
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

// 资源中心已并入设置（a6db22b），Skills 入口现挂在 设置 → 工具 → Skills
function openSkills(): void {
  useDialogStore.getState().openSettings();
}

/** 44px SVG 进度环：r=19，周长 2πr ≈ 119.4 */
const RING_CIRCUMFERENCE = 2 * Math.PI * 19;

function ProgressRing({ completed, total, label }: { completed: number; total: number; label: string }) {
  const offset = RING_CIRCUMFERENCE * (1 - completed / total);
  return (
    <div
      className="relative size-11 shrink-0"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={completed}
      aria-label={label}
    >
      <svg width="44" height="44" viewBox="0 0 44 44" className="-rotate-90">
        <circle cx="22" cy="22" r="19" fill="none" strokeWidth="3.5" className="stroke-[var(--app-hover)]" />
        <circle
          cx="22"
          cy="22"
          r="19"
          fill="none"
          strokeWidth="3.5"
          strokeLinecap="round"
          className="stroke-[var(--app-accent)] transition-[stroke-dashoffset] duration-[var(--dur-slow)] ease-[var(--ease-out)]"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={offset}
        />
      </svg>
      <span className="absolute inset-0 grid place-items-center text-[11px] font-semibold text-[var(--app-accent)]">
        {completed}/{total}
      </span>
    </div>
  );
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
      { id: "workspace", complete: hasWorkspace, action: openExplorer, guidePath: "docs/guide/03-core-concepts.md" },
      { id: "project", complete: hasProject, action: openExplorer, guidePath: "docs/guide/04-getting-started-5-steps.md" },
      { id: "multiLaunch", complete: multiLaunch, action: openOnboarding, guidePath: "docs/guide/05-terminal-and-panes.md" },
      { id: "dispatch", complete: hasDispatch, action: openOrchestration, guidePath: "docs/guide/12-leader-worker.md" },
      { id: "skill", complete: (installedSkillCount ?? 0) > 0, action: openSkills, guidePath: "docs/guide/18-skills.md" },
    ];
  }, [bindings, installedSkillCount, multiLaunch, workspaces]);

  const completed = items.filter((item) => item.complete).length;
  // 聚焦卡指向第一个未完成项（清单有先后语义）
  const nextItem = items.find((item) => !item.complete) ?? null;
  const Heading = variant === "home" ? "h3" : "h2";

  // 完成收束态：整卡缩成一条 success 横条
  if (!nextItem) {
    return (
      <section
        className={cn(
          "flex min-w-0 flex-wrap items-center gap-3 rounded-[10px] border px-[18px] py-3",
          "border-[color-mix(in_srgb,var(--app-status-success)_30%,transparent)]",
          "bg-[color-mix(in_srgb,var(--app-status-success)_8%,transparent)]",
        )}
        data-testid={variant === "home" ? "getting-started" : "setup-guide-checklist"}
      >
        <span className="flex flex-1 basis-60 items-center gap-2 text-[13px] font-semibold text-[var(--app-text-primary)]">
          <BadgeCheck className="size-[18px] shrink-0 text-[var(--app-status-success)]" aria-hidden="true" />
          <span>
            {t("setupGuide.doneTitle")}
            <span className="block text-[11.5px] font-normal text-[var(--app-text-secondary)]">
              {t("setupGuide.doneSummary")}
            </span>
          </span>
        </span>
        <Button type="button" variant="outline" size="sm" onClick={openOnboarding}>
          {t("setupGuide.replay")}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={openSkills}>
          {t("setupGuide.browseSkills")}
        </Button>
      </section>
    );
  }

  const nextDescriptionKey = nextItem.id === "skill" && skillCheckFailed
    ? "setupGuide.items.skill.checkFailed"
    : `setupGuide.items.${nextItem.id}.description`;
  // 0/5 初始态：教程是整卡主 CTA，聚焦卡收起；有进度后教程降级 outline 常驻卡头
  const isFresh = completed === 0;

  return (
    <section
      className={cn(
        "min-w-0",
        variant === "home"
          && "rounded-xl border border-[var(--app-home-border)] bg-[var(--app-home-surface)] p-5",
      )}
      data-testid={variant === "home" ? "getting-started" : "setup-guide-checklist"}
    >
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <Heading className="text-[15px] font-semibold text-[var(--app-text-primary)]">
            {t("setupGuide.title")}
          </Heading>
          <p className="mt-0.5 text-xs leading-relaxed text-[var(--app-text-tertiary)]">
            {t("setupGuide.description")}
          </p>
        </div>
        <Button
          type="button"
          variant={isFresh ? "default" : "outline"}
          size="sm"
          className="shrink-0 gap-1.5 self-center"
          onClick={openOnboarding}
          data-testid="setup-guide-tutorial"
        >
          <Play className="size-3.5" aria-hidden="true" />
          {t(isFresh ? "setupGuide.startTutorial" : "setupGuide.tutorial")}
        </Button>
        <ProgressRing completed={completed} total={items.length} label={t("setupGuide.progressLabel")} />
      </div>

      {/* 旅程条：纯装饰层，读屏走进度环 + 聚焦卡文字 */}
      <div className="mt-[22px] flex items-start" aria-hidden="true">
        {items.map((item, index) => {
          const isCurrent = item === nextItem;
          return (
            <div key={item.id} className="contents">
              {index > 0 && (
                <span
                  className={cn(
                    "mt-[13px] h-[1.5px] min-w-[18px] flex-1",
                    items[index - 1].complete && item.complete
                      ? "bg-[var(--app-status-success)] opacity-55"
                      : items[index - 1].complete
                        ? "bg-[var(--app-status-success)] opacity-55"
                        : "bg-[repeating-linear-gradient(90deg,var(--app-border)_0_5px,transparent_5px_10px)]",
                  )}
                />
              )}
              <div className="flex shrink-0 flex-col items-center gap-2">
                <span
                  className={cn(
                    "relative z-[1] grid place-items-center rounded-full border-[1.5px] text-[11px] font-semibold",
                    isCurrent
                      ? "guide-node-pulse size-[30px] border-[var(--app-accent)] bg-[var(--app-accent)] text-white"
                      : "size-[26px]",
                    !isCurrent && item.complete
                      && "border-[var(--app-status-success)] bg-[color-mix(in_srgb,var(--app-status-success)_12%,transparent)] text-[var(--app-status-success)]",
                    !isCurrent && !item.complete
                      && "border-[var(--app-border)] bg-[var(--app-content)] text-[var(--app-text-tertiary)]",
                  )}
                >
                  {item.complete ? "✓" : index + 1}
                </span>
                <span
                  className={cn(
                    "whitespace-nowrap text-[11px]",
                    isCurrent
                      ? "font-semibold text-[var(--app-text-primary)]"
                      : item.complete
                        ? "text-[var(--app-text-secondary)]"
                        : "text-[var(--app-text-tertiary)]",
                  )}
                >
                  {t(`setupGuide.items.${item.id}.title`)}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* 聚焦卡：唯一主 CTA（初始态收起，主 CTA 让给「开始新手教程」） */}
      {!isFresh && (
        <div
          className={cn(
            "mt-[18px] flex flex-wrap items-center gap-3.5 rounded-[10px] border px-4 py-3.5",
            "border-[color-mix(in_srgb,var(--app-accent)_35%,transparent)] bg-[var(--app-active-bg)]",
          )}
        >
          <div className="min-w-0 flex-1 basis-64">
            <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--app-accent)]">
              {t("setupGuide.nextStep")}
            </span>
            <div className="mt-0.5 text-[13.5px] font-semibold text-[var(--app-text-primary)]">
              {t(`setupGuide.items.${nextItem.id}.title`)}
            </div>
            <div className="mt-0.5 text-xs text-[var(--app-text-secondary)]">
              {t(nextDescriptionKey as never)}
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto px-0"
              onClick={() => void openGuideDoc(nextItem.guidePath)}
            >
              <GraduationCap className="size-3.5" aria-hidden="true" />
              {t("setupGuide.viewGuide")}
            </Button>
            <Button type="button" size="sm" className="gap-1.5" onClick={nextItem.action}>
              {t(`setupGuide.items.${nextItem.id}.action`)}
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-4 border-t border-[var(--app-home-border)] pt-3 text-xs text-[var(--app-text-tertiary)]">
        <span className="flex items-center gap-1.5">
          {t("setupGuide.conciergeHint")}
          <AgentConciergeEntry compact className="inline-flex" />
        </span>
      </div>
    </section>
  );
}
