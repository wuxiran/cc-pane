// OnboardingGuide 的步骤级子组件：步骤导航 / 模式分段选择 / 项目步 / 开始步。
// 均为纯展示 + 回调，状态与流程编排留在 OnboardingGuide 本体。
import { useTranslation } from "react-i18next";
import { FolderOpen, FolderGit2, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { CliTool, Workspace, WorkspaceProject } from "@/types";
import type { ScannedRepo } from "@/services/workspaceService";

export type StepIndex = 0 | 1 | 2;
export const STEP_KEYS = ["environment", "workspace", "parallel"] as const;
export type Preset = "full" | "minimal";

export interface LaunchTarget {
  workspace: Workspace;
  project: WorkspaceProject;
}

export function scannedPaths(repos: readonly ScannedRepo[]): string[] {
  return repos.flatMap((repo) => [repo.mainPath, ...repo.worktrees.map((worktree) => worktree.path)]);
}

/** 步骤导航（顶部横排）：完成✓ / 当前实心 / 未来空心；只允许点击回退已到过的步 */
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
  return (
    <nav aria-label={t("navLabel")} className="mb-5 flex flex-wrap items-center gap-x-1 gap-y-1">
      {STEP_KEYS.map((key, index) => {
        const done = index < step;
        const active = index === step;
        const reachable = index <= maxVisited && !active;
        return (
          <span key={key} className="flex items-center gap-1">
            {index > 0 && (
              <span
                aria-hidden="true"
                className="h-px w-4"
                style={{ background: done || active ? "var(--app-accent)" : "var(--app-border)" }}
              />
            )}
            <button
              type="button"
              aria-current={active ? "step" : undefined}
              disabled={!reachable && !active}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs",
                active
                  ? "font-semibold text-[var(--app-text-primary)]"
                  : done
                    ? "text-[var(--app-text-secondary)]"
                    : "text-[var(--app-text-tertiary)]",
                reachable && "cursor-default hover:bg-[var(--app-hover)]",
              )}
              onClick={() => { if (reachable) onNavigate(index as StepIndex); }}
            >
              <span
                className={cn(
                  "grid size-4 shrink-0 place-items-center rounded-full border text-[length:var(--text-nano)] font-semibold",
                  active
                    ? "border-[var(--app-accent)] bg-[var(--app-accent)] text-[var(--primary-foreground)]"
                    : done
                      ? "border-[var(--app-status-success)] text-[var(--app-status-success)]"
                      : "border-[var(--app-border)] text-[var(--app-text-tertiary)]",
                )}
              >
                {done ? "✓" : index + 1}
              </span>
              {t(`steps.${key}.navTitle` as never)}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

/** 工作台模式：一行分段选择 + 当前项一句说明 */
export function PresetChips({ value, onChange }: { value: Preset; onChange: (preset: Preset) => void }) {
  const { t } = useTranslation("onboarding");
  return (
    <section className="mt-5 space-y-1.5">
      <div className="flex items-center gap-3">
        <h4 className="text-[length:var(--text-caption)] font-medium text-[var(--app-text-tertiary)]">
          {t("preset.groupLabel")}
        </h4>
        <div
          role="radiogroup"
          aria-label={t("preset.groupLabel")}
          className="inline-flex rounded-md border border-[var(--app-border)] p-0.5"
        >
          {(["full", "minimal"] as const).map((preset) => {
            const selected = value === preset;
            return (
              <button
                key={preset}
                type="button"
                role="radio"
                aria-checked={selected}
                className={cn(
                  "rounded px-2.5 py-0.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]",
                  selected
                    ? "bg-[var(--app-active-bg)] font-medium text-[var(--app-text-primary)]"
                    : "text-[var(--app-text-secondary)] hover:text-[var(--app-text-primary)]",
                )}
                onClick={() => onChange(preset)}
              >
                {t(`preset.${preset}.title` as never)}
              </button>
            );
          })}
        </div>
      </div>
      <p className="text-xs leading-5 text-[var(--app-text-tertiary)]">
        {t(`preset.${value}.description` as never)}
      </p>
    </section>
  );
}

export interface WorkspaceStepProps {
  target: LaunchTarget | null;
  /** 有已导入项目时，用户点了「导入其他目录」 */
  importMode: boolean;
  workspaceName: string;
  rootPath: string;
  error: string | null;
  onWorkspaceNameChange: (value: string) => void;
  onRootPathChange: (value: string) => void;
  /** 未提供（非桌面运行时）则不显示「选择…」 */
  onPickFolder?: () => void;
  onImportOther: () => void;
}

export function baseName(path: string): string {
  return path.trim().replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}

/** 项目步：已有项目 → 一张确认卡；否则 → 一个目录输入（工作空间名默认取目录名） */
export function WorkspaceStep(props: WorkspaceStepProps) {
  const { t } = useTranslation("onboarding");
  if (props.target && !props.importMode) {
    const { workspace, project } = props.target;
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-3 py-2.5">
          <FolderGit2 className="size-4 shrink-0 text-[var(--app-accent)]" aria-hidden="true" />
          <div className="min-w-0">
            <p className="truncate text-[length:var(--text-row)] font-medium text-[var(--app-text-primary)]">
              {project.alias || baseName(project.path) || project.path}
            </p>
            <p className="truncate text-xs text-[var(--app-text-tertiary)]">
              {workspace.alias || workspace.name} · {project.path}
            </p>
          </div>
        </div>
        <button
          type="button"
          className="-mx-1 rounded px-1 py-0.5 text-xs text-[var(--app-text-tertiary)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-secondary)]"
          onClick={props.onImportOther}
        >
          {t("workspace.importOther")}
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Input
          aria-label={t("workspace.pathLabel")}
          placeholder={t("workspace.pathPlaceholder")}
          value={props.rootPath}
          onChange={(event) => props.onRootPathChange(event.target.value)}
        />
        {props.onPickFolder && (
          <Button type="button" variant="outline" className="shrink-0 gap-1.5" onClick={props.onPickFolder}>
            <FolderOpen className="size-4" aria-hidden="true" />
            {t("workspace.pick")}
          </Button>
        )}
      </div>
      <label className="flex items-center gap-3 text-xs text-[var(--app-text-tertiary)]">
        <span className="shrink-0">{t("workspace.nameLabel")}</span>
        <Input
          aria-label={t("workspace.nameLabel")}
          className="h-8"
          placeholder={baseName(props.rootPath) || t("workspace.namePlaceholder")}
          value={props.workspaceName}
          onChange={(event) => props.onWorkspaceNameChange(event.target.value)}
        />
      </label>
      {props.error && <p className="text-xs text-[var(--app-status-danger)]">{props.error}</p>}
    </div>
  );
}

/** 开始步：在哪个项目、用哪两个 CLI，一眼看清 */
export function ParallelStep({ target, pair }: { target: LaunchTarget | null; pair: [CliTool, CliTool] | null }) {
  const { t } = useTranslation("onboarding");
  return (
    <div className="space-y-4">
      {!pair ? (
        <p className="text-sm text-[var(--app-status-warning)]">{t("parallel.noCli")}</p>
      ) : !target ? (
        <p className="text-sm text-[var(--app-status-warning)]">{t("parallel.noProject")}</p>
      ) : (
        <div className="space-y-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-3 py-3">
          <p className="truncate text-xs text-[var(--app-text-tertiary)]">
            {t("parallel.where", { project: target.project.alias || baseName(target.project.path) || target.project.path })}
          </p>
          <div className="grid grid-cols-2 gap-2">
            {pair.map((tool, index) => (
              <span
                key={`${tool}-${index}`}
                className="flex items-center gap-2 rounded-md border border-[var(--app-border)] bg-[var(--app-content)] px-3 py-2 text-xs font-medium text-[var(--app-text-primary)]"
              >
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
      )}
      <p className="flex items-start gap-2 text-xs leading-5 text-[var(--app-text-tertiary)]">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>{t("finish.recoverHint")}</span>
      </p>
    </div>
  );
}
