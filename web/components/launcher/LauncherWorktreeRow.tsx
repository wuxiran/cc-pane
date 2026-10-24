import { useTranslation } from "react-i18next";
import LocalLaunchSettings from "./LocalLaunchSettings";
import LauncherEnvRow from "./LauncherEnvRow";
import LauncherProviderRow from "./LauncherProviderRow";
import type { LauncherDraft } from "./launcherModel";
import type { WorkspaceLaunchEnvironment } from "@/types";

interface LauncherWorktreeRowProps {
  draft: LauncherDraft;
  onChange: (patch: Partial<LauncherDraft>) => void;
  projectPath?: string;
  isLocal: boolean;
  disabled?: boolean;
  environment?: WorkspaceLaunchEnvironment;
  environmentLocked?: boolean;
}

export default function LauncherWorktreeRow({ draft, onChange, projectPath, isLocal, disabled, environment: resolvedEnvironment, environmentLocked }: LauncherWorktreeRowProps) {
  const { t } = useTranslation("launcher");
  const environment = resolvedEnvironment ?? (draft.source?.kind === "manual" ? "local" : draft.environment);
  return <LocalLaunchSettings projectPath={projectPath} isLocal={isLocal} disabled={disabled}
    worktree={draft.worktree} onChange={(worktree) => onChange({ worktree })}
    environmentLabel={t(`env.${environment}`)}
    environmentControls={<LauncherEnvRow value={environment} cliTool={draft.cliTool}
      disabled={environmentLocked || draft.source?.kind === "manual" || draft.source?.kind === "recent"}
      onChange={(next) => onChange({ environment: next, worktree: undefined })} />}
    profileControls={<LauncherProviderRow draft={draft} onChange={onChange} />} />;
}
