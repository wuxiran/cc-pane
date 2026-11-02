import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  FolderOpen,
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
  executeWorkspaceMigration,
  previewWorkspaceMigration,
  rollbackWorkspaceMigration,
} from "@/services/workspaceService";
import { discoverWslDistros } from "@/services/sshMachineService";
import { useWorkspacesStore } from "@/stores";
import type {
  Workspace,
  WorkspaceMigrationPlan,
  WorkspaceMigrationRequest,
  WorkspaceMigrationResult,
  WorkspaceMigrationTargetKind,
  WslDistro,
} from "@/types";
import { detectAppPlatform, formatSize, getErrorMessage, isTauriRuntime, toWslPath } from "@/utils";

interface WorkspaceMigrationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: Workspace | null;
}

export default function WorkspaceMigrationDialog({
  open,
  onOpenChange,
  workspace,
}: WorkspaceMigrationDialogProps) {
  const { t } = useTranslation("sidebar");
  const reloadWorkspaces = useWorkspacesStore((state) => state.load);
  const platform = useMemo(() => detectAppPlatform(), []);
  const isWindows = platform === "windows";

  const [targetKind, setTargetKind] = useState<WorkspaceMigrationTargetKind>(
    isWindows ? "wsl" : "local"
  );
  const [targetRoot, setTargetRoot] = useState("");
  const [targetDistro, setTargetDistro] = useState("");
  const [previewPlan, setPreviewPlan] = useState<WorkspaceMigrationPlan | null>(null);
  const [migrationResult, setMigrationResult] = useState<WorkspaceMigrationResult | null>(null);
  const [wslDistros, setWslDistros] = useState<WslDistro[]>([]);
  const [wslLoading, setWslLoading] = useState(false);
  const [loading, setLoading] = useState<"preview" | "execute" | "rollback" | null>(null);
  const [previewKey, setPreviewKey] = useState("");

  const currentRequest = useMemo<WorkspaceMigrationRequest | null>(() => {
    if (!workspace) return null;
    return {
      workspaceName: workspace.name,
      targetKind,
      targetRoot: targetRoot.trim(),
      targetDistro: targetKind === "wsl" ? targetDistro.trim() || undefined : undefined,
    };
  }, [targetDistro, targetKind, targetRoot, workspace]);

  const currentRequestKey = useMemo(
    () => JSON.stringify(currentRequest ?? {}),
    [currentRequest]
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
    if (!open || !workspace) return;

    const nextTargetKind: WorkspaceMigrationTargetKind = isWindows ? "wsl" : "local";
    setTargetKind(nextTargetKind);
    setTargetRoot(
      isWindows
        ? workspace.wsl?.remotePath || toWslPath(workspace.path) || ""
        : workspace.path || ""
    );
    setTargetDistro(workspace.wsl?.distro || "");
    setPreviewPlan(null);
    setMigrationResult(null);
    setPreviewKey("");
  }, [isWindows, open, workspace]);

  useEffect(() => {
    if (!open || !isWindows || targetKind !== "wsl") return;
    loadWslOptions().catch(() => {});
  }, [isWindows, loadWslOptions, open, targetKind]);

  const handleBrowseLocalRoot = useCallback(async () => {
    if (!isTauriRuntime()) {
      const selected = window.prompt(t("workspaceMigration.chooseDirTitle"), targetRoot);
      if (selected) {
        setTargetRoot(selected);
      }
      return;
    }
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: t("workspaceMigration.chooseDirTitle"),
    });
    if (typeof selected === "string") {
      setTargetRoot(selected);
    }
  }, [targetRoot, t]);

  const handlePreview = useCallback(async () => {
    if (!currentRequest) return;
    setLoading("preview");
    try {
      const plan = await previewWorkspaceMigration(currentRequest);
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
      const result = await executeWorkspaceMigration(currentRequest);
      setPreviewPlan(result.plan);
      setMigrationResult(result);
      setPreviewKey(currentRequestKey);
      await reloadWorkspaces();
      toast.success(t("workspaceMigration.done"));
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setLoading(null);
    }
  }, [currentRequest, currentRequestKey, reloadWorkspaces, t]);

  const handleRollback = useCallback(async () => {
    if (!workspace || !migrationResult) return;
    setLoading("rollback");
    try {
      await rollbackWorkspaceMigration(workspace.name, migrationResult.snapshotId);
      await reloadWorkspaces();
      setMigrationResult(null);
      toast.success(t("workspaceMigration.rolledBack"));
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setLoading(null);
    }
  }, [migrationResult, reloadWorkspaces, t, workspace]);

  const canExecute =
    !!previewPlan &&
    previewKey === currentRequestKey &&
    loading !== "execute" &&
    loading !== "preview";

  const supportsWsl = isWindows;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("workspaceMigration.title")}</DialogTitle>
        </DialogHeader>

        {!workspace ? null : (
          <div className="space-y-4">
            <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-glass-bg)] p-3 text-sm">
              <div className="font-medium text-[var(--app-text-primary)]">
                {workspace.alias || workspace.name}
              </div>
              <div className="mt-1 text-xs text-[var(--app-text-secondary)]">
                {t("workspaceMigration.sourceDir")}：{workspace.path || t("workspaceMigration.notSet")}
              </div>
              <div className="mt-2 text-xs text-[var(--app-status-warning)]">
                {t("workspaceMigration.flowHint")}
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-[180px_minmax(0,1fr)]">
              <div className="space-y-2">
                <div className="text-xs font-medium text-[var(--app-text-secondary)]">
                  {t("workspaceMigration.targetEnv")}
                </div>
                <button
                  className={targetButtonClass(targetKind === "local")}
                  onClick={() => setTargetKind("local")}
                  type="button"
                >
                  {t("workspaceMigration.local")}
                </button>
                {supportsWsl ? (
                  <button
                    className={targetButtonClass(targetKind === "wsl")}
                    onClick={() => setTargetKind("wsl")}
                    type="button"
                  >
                    <MonitorSmartphone className="h-4 w-4" />
                    WSL
                  </button>
                ) : null}
                <button
                  className={targetButtonClass(false, true)}
                  disabled
                  type="button"
                >
                  {t("workspaceMigration.sshLater")}
                </button>
              </div>

              <div className="space-y-3">
                {targetKind === "local" ? (
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-[var(--app-text-secondary)]">
                      {t("workspaceMigration.targetDir")}
                    </label>
                    <div className="flex gap-2">
                      <Input
                        value={targetRoot}
                        onChange={(event) => setTargetRoot(event.target.value)}
                        placeholder="D:/workspace-wsl-copy"
                      />
                      <Button onClick={handleBrowseLocalRoot} type="button" variant="outline">
                        <FolderOpen className="h-4 w-4" />
                        {t("workspaceMigration.choose")}
                      </Button>
                    </div>
                  </div>
                ) : null}

                {targetKind === "wsl" ? (
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <label className="text-xs font-medium text-[var(--app-text-secondary)]">
                          {t("workspaceMigration.wslDistro")}
                        </label>
                        <button
                          className="inline-flex items-center gap-1 text-xs text-[var(--app-text-secondary)] hover:text-[var(--app-accent)]"
                          onClick={() => loadWslOptions()}
                          type="button"
                        >
                          <RefreshCw className={`h-3.5 w-3.5 ${wslLoading ? "animate-spin" : ""}`} />
                          {t("workspaceMigration.refresh")}
                        </button>
                      </div>
                      <select
                        className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none"
                        onChange={(event) => setTargetDistro(event.target.value)}
                        value={targetDistro}
                      >
                        <option value="">{t("workspaceMigration.wslDefaultDistro")}</option>
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
                        {t("workspaceMigration.wslRoot")}
                      </label>
                      <Input
                        value={targetRoot}
                        onChange={(event) => setTargetRoot(event.target.value)}
                        placeholder="/home/dev/workspaces/my-workspace"
                      />
                    </div>
                  </div>
                ) : null}

                <div className="flex flex-wrap gap-2">
                  <Button onClick={handlePreview} type="button" variant="outline">
                    {loading === "preview" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {t("workspaceMigration.precheck")}
                  </Button>
                  <Button disabled={!canExecute} onClick={handleExecute} type="button">
                    {loading === "execute" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {t("workspaceMigration.run")}
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
                      {t("workspaceMigration.rollback")}
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>

            {previewPlan ? (
              <div className="rounded-lg border border-[var(--app-border)]">
                <div className="border-b border-[var(--app-border)] px-4 py-3">
                  <div className="text-sm font-medium text-[var(--app-text-primary)]">
                    {t("workspaceMigration.preview")}
                  </div>
                  <div className="mt-1 text-xs text-[var(--app-text-secondary)]">
                    {previewPlan.sourceRoot}
                    <ArrowRight className="mx-2 inline h-3.5 w-3.5" />
                    {previewPlan.targetRoot}
                  </div>
                </div>

                <div className="max-h-72 space-y-2 overflow-y-auto px-4 py-3">
                  {previewPlan.items.length === 0 ? (
                    <div className="text-sm text-[var(--app-text-secondary)]">
                      {t("workspaceMigration.noProjectsHint")}
                    </div>
                  ) : (
                    previewPlan.items.map((item) => (
                      <div
                        className="rounded-lg border border-[var(--app-border)] bg-[var(--app-glass-bg)] p-3"
                        key={item.projectId}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm font-medium text-[var(--app-text-primary)]">
                            {item.projectName}
                          </div>
                          {item.external ? (
                            <span className="rounded-full border border-[var(--app-border)] px-2 py-0.5 text-[length:var(--text-micro)] uppercase tracking-wide text-[var(--app-text-secondary)]">
                              external
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-2 text-xs text-[var(--app-text-secondary)]">
                          <div>{item.sourcePath}</div>
                          <div className="mt-1 flex items-center gap-1">
                            <ArrowRight className="h-3.5 w-3.5 shrink-0" />
                            <span className="break-all">{item.destinationPath}</span>
                          </div>
                        </div>
                      </div>
                    ))
                  )}

                  {previewPlan.warnings.length > 0 ? (
                    <div className="rounded-lg border border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-bg)] px-3 py-2 text-xs text-[var(--app-status-warning)]">
                      {previewPlan.warnings.map((warning) => (
                        <div key={warning}>{warning}</div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {migrationResult ? (
              <div className="rounded-lg border border-[color-mix(in_srgb,var(--app-status-success)_30%,transparent)] bg-[var(--app-status-success-bg)] px-4 py-3 text-sm text-[var(--app-status-success)]">
                <div>{t("workspaceMigration.switched")}</div>
                <div className="mt-1 text-xs">
                  {t("workspaceMigration.copiedSummary", {
                    files: migrationResult.copiedFiles,
                    size: formatSize(migrationResult.copiedBytes),
                  })}
                </div>
                <div className="mt-1 text-xs">
                  {t("workspaceMigration.snapshotId", { id: migrationResult.snapshotId })}
                </div>
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} type="button" variant="secondary">
            {t("workspaceMigration.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function targetButtonClass(active: boolean, disabled = false): string {
  return [
    "flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
    active
      ? "border-[var(--app-accent)] bg-[var(--app-active-bg)] text-[var(--app-accent)]"
      : "border-[var(--app-border)] text-[var(--app-text-secondary)]",
    disabled ? "cursor-not-allowed opacity-50" : "hover:bg-[var(--app-hover)]",
  ].join(" ");
}
