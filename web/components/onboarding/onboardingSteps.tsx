// OnboardingGuide 的步骤级子组件：步骤导航 / 模式双选 chip / 建空间表单 / 并排启动 / 就绪。
// 均为纯展示 + 回调，状态与流程编排留在 OnboardingGuide 本体。
import { useTranslation } from "react-i18next";
import { Check, FolderSearch, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { CliTool, Workspace, WorkspaceProject } from "@/types";
import type { ScannedRepo } from "@/services/workspaceService";

export type StepIndex = 0 | 1 | 2 | 3;
export type Preset = "full" | "minimal";

export interface LaunchTarget {
  workspace: Workspace;
  project: WorkspaceProject;
}

export function scannedPaths(repos: readonly ScannedRepo[]): string[] {
  return repos.flatMap((repo) => [repo.mainPath, ...repo.worktrees.map((worktree) => worktree.path)]);
}

/** 步骤导航：完成✓ / 当前实心 / 未来空心；只允许点击回退已到过的步 */
export function StepNav({
  step,
  maxVisited,
  onNavigate,
}: {
  step: StepIndex;
  maxVisited: StepIndex;
  onNavigate: (target: StepIndex) => void;
}) {
  const { t } = useTranslation("onboarding");
  const stepKeys = ["environment", "workspace", "parallel", "finish"] as const;
  return (
    <nav aria-label={t("navLabel")} className="mb-5 flex flex-col gap-0.5">
      {stepKeys.map((key, index) => {
        const done = index < step;
        const active = index === step;
        const reachable = index <= maxVisited && !active;
        return (
          <button
            key={key}
            type="button"
            aria-current={active ? "step" : undefined}
            disabled={!reachable && !active}
            className={cn(
              "-mx-2 flex items-center gap-2.5 rounded-[7px] px-2 py-[5px] text-left text-xs",
              active
                ? "font-semibold text-[var(--app-text-primary)]"
                : done
                  ? "text-[var(--app-text-secondary)]"
                  : "text-[var(--app-text-tertiary)]",
              reachable && "cursor-pointer hover:bg-[var(--app-hover)]",
            )}
            onClick={() => { if (reachable) onNavigate(index as StepIndex); }}
          >
            <span
              className={cn(
                "grid size-[18px] shrink-0 place-items-center rounded-full border-[1.5px] text-[10px] font-semibold",
                active
                  ? "border-[var(--app-accent)] bg-[var(--app-accent)] text-white"
                  : done
                    ? "border-[var(--app-status-success)] bg-[color-mix(in_srgb,var(--app-status-success)_10%,transparent)] text-[var(--app-status-success)]"
                    : "border-[var(--app-border)] text-[var(--app-text-tertiary)]",
              )}
            >
              {done ? "✓" : index + 1}
            </span>
            {t(`steps.${key}.navTitle` as never)}
          </button>
        );
      })}
    </nav>
  );
}

/** 模式双选 chip（并入环境预检步） */
export function PresetChips({ value, onChange }: { value: Preset; onChange: (preset: Preset) => void }) {
  const { t } = useTranslation("onboarding");
  return (
    <div role="radiogroup" aria-label={t("preset.groupLabel")} className="mt-4 grid gap-2 sm:grid-cols-2">
      {(["full", "minimal"] as const).map((preset) => {
        const selected = value === preset;
        return (
          <button
            key={preset}
            type="button"
            role="radio"
            aria-checked={selected}
            className="flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
            style={{
              borderColor: selected ? "var(--app-accent)" : "var(--app-border)",
              background: selected ? "var(--app-active-bg)" : "var(--app-panel-bg)",
            }}
            onClick={() => onChange(preset)}
          >
            <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-[var(--app-border)]">
              {selected && <Check className="size-3 text-[var(--app-accent)]" aria-hidden="true" />}
            </span>
            <span>
              <span className="block text-[13px] font-semibold text-[var(--app-text-primary)]">
                {t(`preset.${preset}.title` as never)}
              </span>
              <span className="mt-0.5 block text-[11.5px] leading-4 text-[var(--app-text-secondary)]">
                {t(`preset.${preset}.description` as never)}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export interface WorkspaceStepProps {
  target: LaunchTarget | null;
  workspaceName: string;
  rootPath: string;
  repos: readonly ScannedRepo[];
  busy: boolean;
  error: string | null;
  onWorkspaceNameChange: (value: string) => void;
  onRootPathChange: (value: string) => void;
  onScan: () => void;
}

export function WorkspaceStep(props: WorkspaceStepProps) {
  const { t } = useTranslation("onboarding");
  return (
    <div className="space-y-4">
      <div className="space-y-2 text-xs leading-5 text-[var(--app-text-secondary)]">
        <p>{t("workspace.principleGather")}</p>
        <p>{t("workspace.principleMaterials")}</p>
        <p>{t("workspace.principlePortable")}</p>
      </div>
      {props.target && (
        <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-3 py-2 text-xs text-[var(--app-text-secondary)]">
          {t("workspace.currentProject", {
            workspace: props.target.workspace.alias || props.target.workspace.name,
            project: props.target.project.alias || props.target.project.path,
          })}
        </div>
      )}
      <div className="space-y-3">
        <Input
          aria-label={t("workspace.nameLabel")}
          placeholder={t("workspace.namePlaceholder")}
          value={props.workspaceName}
          onChange={(event) => props.onWorkspaceNameChange(event.target.value)}
        />
        <div className="flex gap-2">
          <Input
            aria-label={t("workspace.pathLabel")}
            placeholder={t("workspace.pathPlaceholder")}
            value={props.rootPath}
            onChange={(event) => props.onRootPathChange(event.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            className="shrink-0 gap-1.5"
            disabled={props.busy || !props.rootPath.trim()}
            onClick={props.onScan}
          >
            <FolderSearch className="size-4" aria-hidden="true" />
            {t("workspace.scan")}
          </Button>
        </div>
      </div>
      {props.repos.length > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-3 py-2">
          <Check className="size-3.5 shrink-0 text-[var(--app-status-success)]" aria-hidden="true" />
          <span className="text-xs text-[var(--app-text-secondary)]">
            {t("workspace.found", { count: scannedPaths(props.repos).length })}
          </span>
        </div>
      )}
      {props.error && <p className="text-xs text-[var(--app-status-danger)]">{props.error}</p>}
    </div>
  );
}

export function ParallelStep({ target, pair }: { target: LaunchTarget | null; pair: [CliTool, CliTool] | null }) {
  const { t } = useTranslation("onboarding");
  if (!pair) return <p className="text-sm text-[var(--app-status-warning)]">{t("parallel.noCli")}</p>;
  if (!target) return <p className="text-sm text-[var(--app-status-warning)]">{t("parallel.noProject")}</p>;
  return (
    <div className="space-y-4">
      <p className="text-sm leading-6 text-[var(--app-text-secondary)]">
        {t("parallel.description", { project: target.project.alias || target.project.path })}
      </p>
      <div className="flex items-center gap-2">
        {pair.map((tool, index) => (
          <span key={`${tool}-${index}`} className="flex items-center gap-1.5 rounded-md border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-3 py-1.5 text-xs font-medium text-[var(--app-text-primary)]">
            <span
              className="size-2 rounded-full"
              style={{ background: tool === "codex" ? "var(--app-cli-codex)" : "var(--app-cli-claude)" }}
              aria-hidden="true"
            />
            {tool}
          </span>
        ))}
      </div>
    </div>
  );
}

export function FinishStep() {
  const { t } = useTranslation("onboarding");
  return (
    <div className="space-y-4">
      <ul className="space-y-2 text-xs text-[var(--app-text-secondary)]">
        <li>{t("finish.explorer")}</li>
        <li>{t("finish.rightDock")}</li>
        <li>{t("finish.skills")}</li>
      </ul>
      <div className="flex items-start gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-3 py-2.5 text-xs leading-5 text-[var(--app-text-secondary)]">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>{t("finish.recoverHint")}</span>
      </div>
    </div>
  );
}
