import { useEffect, useState, type ReactNode } from "react";
import { GitBranch, Monitor, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { gitService, type GitRepoInfo } from "@/services/gitService";
import { newSessionBranch } from "@/services/localLaunchService";
import type { LocalWorktreeDraft } from "@/types/localLaunch";

interface LocalLaunchSettingsProps {
  projectPath?: string;
  isLocal?: boolean;
  worktree?: LocalWorktreeDraft;
  onChange: (worktree: LocalWorktreeDraft) => void;
  disabled?: boolean;
  environmentLabel?: string;
  environmentControls?: ReactNode;
  profileControls?: ReactNode;
}

/** Branch selection only targets a new isolated worktree; the source checkout never switches. */
export default function LocalLaunchSettings({
  projectPath, isLocal = true, worktree, onChange, disabled,
  environmentLabel, environmentControls, profileControls,
}: LocalLaunchSettingsProps) {
  const { t } = useTranslation("launcher");
  const [open, setOpen] = useState(false);
  const [repo, setRepo] = useState<{ path: string; info: GitRepoInfo } | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setRepo(null);
    setBranches([]);
    setLoadError(null);
    if (!projectPath || !isLocal) return;
    gitService.getRepoInfo(projectPath).then((info) => {
      if (!cancelled) setRepo({ path: projectPath, info });
    }).catch((error: unknown) => {
      if (!cancelled) setLoadError(String(error));
    });
    return () => { cancelled = true; };
  }, [projectPath, isLocal, open]);
  const info = repo && repo.path === projectPath ? repo.info : null;
  const available = isLocal && info?.state === "ok";
  useEffect(() => {
    let cancelled = false;
    if (!open || !available || !projectPath) return;
    gitService.getLocalBranches(projectPath).then((values) => {
      if (!cancelled) setBranches(values);
    }).catch((error: unknown) => {
      if (!cancelled) setLoadError(String(error));
    });
    return () => { cancelled = true; };
  }, [open, available, projectPath]);
  const enabled = available && worktree?.enabled === true;
  const reason = !projectPath ? t("worktreeUnavailableNoProject")
    : !isLocal ? t("worktreeUnavailableRemote")
      : loadError ? t("launchSettingsReadFailed")
        : !info ? t("worktreeChecking")
          : info.state !== "ok" ? t("worktreeUnavailableNotGit") : null;
  const baseRef = worktree?.baseRef || "HEAD";
  const change = (patch: Partial<LocalWorktreeDraft>) => onChange({
    enabled: worktree?.enabled ?? false, branch: worktree?.branch || newSessionBranch(),
    baseRef, ...patch,
  });

  return (
    <Popover open={open && !disabled} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" disabled={disabled} aria-label={t("launchSettings")}
          className="flex max-w-full items-center gap-2 rounded-lg border border-[var(--app-border)] px-2.5 py-1.5 text-xs text-[var(--app-text-secondary)] transition-colors hover:bg-[var(--app-hover)] disabled:opacity-50">
          <Monitor className="h-3.5 w-3.5 shrink-0" />
          <span>{environmentLabel ?? t("env.local")}</span>
          {info?.state === "ok" && <span className="flex min-w-0 items-center gap-1">
            <GitBranch className="h-3 w-3 shrink-0" />
            <span className="max-w-40 truncate">{enabled ? worktree?.branch : info.branch || "HEAD"}</span>
          </span>}
          <Settings2 className="h-3.5 w-3.5 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-4 rounded-2xl border-[var(--app-border)] bg-[var(--app-panel-bg)] p-5 shadow-xl">
        <div className="text-xs font-semibold text-[var(--app-text-secondary)]">{t("launchSettings")}</div>
        {environmentControls && <div className="space-y-1.5"><div className="text-xs">{t("environment")}</div>{environmentControls}</div>}
        {!environmentControls && <div className="flex items-center justify-between text-xs text-[var(--app-text-secondary)]">
          <span>{t("environment")}</span><span>{environmentLabel ?? t("env.local")}</span>
        </div>}
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>{t("worktreeEnable")}</span>
          <Switch checked={enabled} disabled={!available || disabled}
            aria-label={t("worktreeEnable")} onCheckedChange={(checked) => change({ enabled: checked })} />
        </label>
        {reason && <p data-testid="worktree-reason" className="text-xs text-[var(--app-text-tertiary)]">{reason}</p>}
        <label className="flex items-center justify-between gap-3 text-xs">
          <span>{enabled ? t("worktreeBaseBranch") : t("worktreeCurrentBranch")}</span>
          {enabled ? <select aria-label={t("worktreeBaseBranch")} value={baseRef}
            className="h-8 max-w-48 rounded-md border bg-background px-2 text-xs"
            onChange={(event) => change({ baseRef: event.target.value })}>
            <option value="HEAD">{t("worktreeCurrentHead", { branch: info?.branch || "HEAD" })}</option>
            {branches.map((branch) => <option key={branch} value={`refs/heads/${branch}`}>{branch}</option>)}
          </select> : <span className="max-w-48 truncate">{info?.branch || "—"}</span>}
        </label>
        {enabled ? <label className="block space-y-1.5 text-xs">
          <span>{t("worktreeNewBranch")}</span>
          <input value={worktree?.branch ?? ""} aria-label={t("worktreeNewBranch")}
            className="h-8 w-full rounded-md border bg-background px-2 text-xs"
            onChange={(event) => change({ branch: event.target.value })} />
          <p className="text-[var(--app-text-tertiary)]">{t("worktreeCleanBaseHint")}</p>
        </label> : available && <p className="text-xs text-[var(--app-text-tertiary)]">{t("worktreeCurrentBranchHint")}</p>}
        {profileControls && <div className="space-y-1.5 border-t border-[var(--app-border)] pt-3">
          <div className="text-xs">{t("sectionProvider")}</div>{profileControls}
        </div>}
      </PopoverContent>
    </Popover>
  );
}
