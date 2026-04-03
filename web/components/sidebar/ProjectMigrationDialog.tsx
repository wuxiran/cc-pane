import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ArrowRight,
  Loader2,
  MonitorSmartphone,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  executeProjectMigration,
  previewProjectMigration,
  rollbackProjectMigration,
} from "@/services/workspaceService";
import { discoverWslDistros } from "@/services/sshMachineService";
import { useWorkspacesStore } from "@/stores";
import type {
  ProjectMigrationPlan,
  ProjectMigrationRequest,
  ProjectMigrationResult,
  Workspace,
  WorkspaceProject,
  WslDistro,
} from "@/types";
import { detectAppPlatform, formatSize, getErrorMessage, toWslPath } from "@/utils";

interface ProjectMigrationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: Workspace | null;
  project: WorkspaceProject | null;
}

export default function ProjectMigrationDialog({
  open,
  onOpenChange,
  workspace,
  project,
}: ProjectMigrationDialogProps) {
  const reloadWorkspaces = useWorkspacesStore((state) => state.load);
  const platform = useMemo(() => detectAppPlatform(), []);
  const isWindows = platform === "windows";

  const [targetRoot, setTargetRoot] = useState("");
  const [targetDistro, setTargetDistro] = useState("");
  const [previewPlan, setPreviewPlan] = useState<ProjectMigrationPlan | null>(null);
  const [migrationResult, setMigrationResult] = useState<ProjectMigrationResult | null>(null);
  const [wslDistros, setWslDistros] = useState<WslDistro[]>([]);
  const [wslLoading, setWslLoading] = useState(false);
  const [loading, setLoading] = useState<"preview" | "execute" | "rollback" | null>(null);
  const [previewKey, setPreviewKey] = useState("");

  const currentRequest = useMemo<ProjectMigrationRequest | null>(() => {
    if (!workspace || !project) return null;
    return {
      workspaceName: workspace.name,
      projectId: project.id,
      targetKind: "wsl",
      targetRoot: targetRoot.trim(),
      targetDistro: targetDistro.trim() || undefined,
    };
  }, [project, targetDistro, targetRoot, workspace]);

  const currentRequestKey = useMemo(
    () => JSON.stringify(currentRequest ?? {}),
    [currentRequest],
  );

  const loadWslOptions = useCallback(async () => {
    if (!isWindows) return;
    setWslLoading(true);
    try {
      setWslDistros(await discoverWslDistros());
    } catch (error) {
      toast.error(getErrorMessage(error));
      setWslDistros([]);
    } finally {
      setWslLoading(false);
    }
  }, [isWindows]);

  useEffect(() => {
    if (!open) return;
    setTargetRoot(project?.wslRemotePath || toWslPath(project?.path) || "");
    setTargetDistro(workspace?.wsl?.distro || "");
    setPreviewPlan(null);
    setMigrationResult(null);
    setPreviewKey("");
  }, [open, project, workspace]);

  useEffect(() => {
    if (!open || !isWindows) return;
    loadWslOptions().catch(() => {});
  }, [isWindows, loadWslOptions, open]);

  const handlePreview = useCallback(async () => {
    if (!currentRequest) return;
    setLoading("preview");
    try {
      const plan = await previewProjectMigration(currentRequest);
      setPreviewPlan(plan);
      setMigrationResult(null);
      setPreviewKey(currentRequestKey);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setLoading(null);
    }
  }, [currentRequest, currentRequestKey]);

  const handleExecute = useCallback(async () => {
    if (!currentRequest) return;
    setLoading("execute");
    try {
      const result = await executeProjectMigration(currentRequest);
      setPreviewPlan(result.plan);
      setMigrationResult(result);
      setPreviewKey(currentRequestKey);
      await reloadWorkspaces();
      toast.success("Project migration completed. Source directory was not deleted.");
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setLoading(null);
    }
  }, [currentRequest, currentRequestKey, reloadWorkspaces]);

  const handleRollback = useCallback(async () => {
    if (!workspace || !migrationResult) return;
    setLoading("rollback");
    try {
      await rollbackProjectMigration(workspace.name, migrationResult.snapshotId);
      await reloadWorkspaces();
      setMigrationResult(null);
      toast.success("Project migration config rolled back. Copied target files were kept.");
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setLoading(null);
    }
  }, [migrationResult, reloadWorkspaces, workspace]);

  const canExecute =
    !!previewPlan &&
    previewKey === currentRequestKey &&
    loading !== "execute" &&
    loading !== "preview";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Project To WSL</DialogTitle>
        </DialogHeader>

        {!workspace || !project ? null : (
          <div className="space-y-4">
            <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-glass-bg)] p-3 text-sm">
              <div className="font-medium text-[var(--app-text-primary)]">
                {project.alias || project.path.split(/[/\\]/).pop() || project.path}
              </div>
              <div className="mt-1 text-xs text-[var(--app-text-secondary)]">
                Workspace: {workspace.alias || workspace.name}
              </div>
              <div className="mt-1 text-xs text-[var(--app-text-secondary)]">
                Source: {project.path}
              </div>
              <div className="mt-2 text-xs text-amber-600">
                Flow is always preview, copy, verify, then switch metadata. The source directory is kept.
              </div>
            </div>

            {!isWindows ? (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700">
                WSL project migration is only available on Windows.
              </div>
            ) : null}

            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-[var(--app-text-primary)]">
                <MonitorSmartphone className="h-4 w-4 text-[var(--app-accent)]" />
                WSL Target
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-xs font-medium text-[var(--app-text-secondary)]">
                    Distro
                  </label>
                  <button
                    className="inline-flex items-center gap-1 text-xs text-[var(--app-text-secondary)] hover:text-[var(--app-accent)]"
                    onClick={() => loadWslOptions()}
                    type="button"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${wslLoading ? "animate-spin" : ""}`} />
                    Refresh
                  </button>
                </div>
                <select
                  className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none"
                  onChange={(event) => setTargetDistro(event.target.value)}
                  value={targetDistro}
                >
                  <option value="">Use default distro</option>
                  {wslDistros.map((distro) => (
                    <option key={distro.name} value={distro.name}>
                      {distro.name}
                      {distro.isDefault ? " (Default)" : ""}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium text-[var(--app-text-secondary)]">
                  Target path
                </label>
                <Input
                  value={targetRoot}
                  onChange={(event) => setTargetRoot(event.target.value)}
                  placeholder="/home/dev/project-name"
                />
              </div>

              <div className="flex flex-wrap gap-2">
                <Button disabled={!isWindows} onClick={handlePreview} type="button" variant="outline">
                  {loading === "preview" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Preview
                </Button>
                <Button disabled={!isWindows || !canExecute} onClick={handleExecute} type="button">
                  {loading === "execute" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Execute
                </Button>
                {migrationResult ? (
                  <Button
                    disabled={loading === "rollback"}
                    onClick={handleRollback}
                    type="button"
                    variant="secondary"
                  >
                    {loading === "rollback" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RotateCcw className="h-4 w-4" />
                    )}
                    Rollback Metadata
                  </Button>
                ) : null}
              </div>
            </div>

            {previewPlan ? (
              <div className="rounded-lg border border-[var(--app-border)]">
                <div className="border-b border-[var(--app-border)] px-4 py-3">
                  <div className="text-sm font-medium text-[var(--app-text-primary)]">
                    Preview
                  </div>
                  <div className="mt-1 text-xs text-[var(--app-text-secondary)]">
                    {previewPlan.sourcePath}
                    <ArrowRight className="mx-2 inline h-3.5 w-3.5" />
                    {previewPlan.destinationPath}
                  </div>
                </div>

                <div className="space-y-2 px-4 py-3 text-xs text-[var(--app-text-secondary)]">
                  <div>Project: {previewPlan.projectName}</div>
                  <div>Target root: {previewPlan.targetRoot}</div>
                  {previewPlan.targetDistro ? <div>Distro: {previewPlan.targetDistro}</div> : null}
                  {previewPlan.warnings.length > 0 ? (
                    <div className="space-y-1 pt-2 text-amber-600">
                      {previewPlan.warnings.map((warning) => (
                        <div key={warning}>{warning}</div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {migrationResult ? (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700">
                <div>
                  Copied files: {migrationResult.copiedFiles}, copied size: {formatSize(migrationResult.copiedBytes)}
                </div>
                <div className="mt-1 text-xs">Snapshot: {migrationResult.snapshotId}</div>
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} type="button" variant="secondary">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
