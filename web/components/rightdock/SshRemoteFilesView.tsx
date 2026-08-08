import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  AlertCircle,
  ArrowLeft,
  ChevronsDownUp,
  Eye,
  EyeOff,
  FolderOpen,
  Home,
  LayoutList,
  ListTree,
  Loader2,
  LockKeyhole,
  RefreshCw,
  Server,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import SshPasswordDialog from "@/components/ssh/SshPasswordDialog";
import { sshFileService } from "@/services";
import {
  useRightDockStore,
  useActivityBarStore,
  useEditorTabsStore,
  useSshMachinesStore,
  useSshRemoteFilePreferencesStore,
  useSshRemoteFilesStore,
} from "@/stores";
import type { DirListing, FsEntry } from "@/types/filesystem";
import type { OpenTerminalOptions } from "@/types";
import { getErrorMessage } from "@/utils";
import SshRemoteFileBrowser from "./SshRemoteFileBrowser";
import {
  buildTerminalOptions,
  EntryNameDialog,
  IconButton,
  isPasswordAuthenticationError,
  PanelMessage,
  PermissionDialog,
  permissionsToOctal,
  type EntryDialog,
  type PermissionDialogState,
} from "./SshRemoteFilesSupport";
import { useSshRemoteTerminalNavigation } from "./useSshRemoteTerminalNavigation";

interface SshRemoteFilesViewProps {
  onOpenTerminal?: (options: OpenTerminalOptions) => void;
}

export default function SshRemoteFilesView({ onOpenTerminal }: SshRemoteFilesViewProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const machines = useSshMachinesStore((state) => state.machines);
  const machineId = useSshRemoteFilesStore((state) => state.machineId);
  const currentPath = useSshRemoteFilesStore((state) => state.currentPath);
  const openMachine = useSshRemoteFilesStore((state) => state.openMachine);
  const navigateTo = useSshRemoteFilesStore((state) => state.navigateTo);
  const replaceCurrentPath = useSshRemoteFilesStore((state) => state.replaceCurrentPath);
  const goBack = useSshRemoteFilesStore((state) => state.goBack);
  const canGoBack = useSshRemoteFilesStore((state) => state.canGoBack);
  const markSessionPassword = useSshRemoteFilesStore((state) => state.markSessionPassword);
  const forgetSessionPassword = useSshRemoteFilesStore((state) => state.forgetSessionPassword);
  const getCachedDirectory = useSshRemoteFilesStore((state) => state.getCachedDirectory);
  const cacheDirectory = useSshRemoteFilesStore((state) => state.cacheDirectory);
  const clear = useSshRemoteFilesStore((state) => state.clear);

  const viewMode = useSshRemoteFilePreferencesStore((state) => state.viewMode);
  const sortKey = useSshRemoteFilePreferencesStore((state) => state.sortKey);
  const sortDirection = useSshRemoteFilePreferencesStore((state) => state.sortDirection);
  const setViewMode = useSshRemoteFilePreferencesStore((state) => state.setViewMode);
  const setSort = useSshRemoteFilePreferencesStore((state) => state.setSort);

  const [listing, setListing] = useState<DirListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(true);
  const [treeResetKey, setTreeResetKey] = useState(0);
  const [entryDialog, setEntryDialog] = useState<EntryDialog>(null);
  const [entryName, setEntryName] = useState("");
  const [permissionDialog, setPermissionDialog] = useState<PermissionDialogState | null>(null);
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [passwordPromptMachineId, setPasswordPromptMachineId] = useState<string | null>(null);
  const requestRef = useRef(0);

  const machine = useMemo(
    () => machines.find((candidate) => candidate.id === machineId) ?? null,
    [machineId, machines],
  );
  const needsPassword = machine?.authMethod === "password"
    && passwordPromptMachineId === machine.id;
  const changeTerminalDirectory = useSshRemoteTerminalNavigation(machineId);

  const handleAuthenticationError = useCallback((message: string) => {
    if (machine?.authMethod !== "password" || !isPasswordAuthenticationError(message)) return;
    forgetSessionPassword(machine.id);
    setPasswordPromptMachineId(machine.id);
    setPasswordDialogOpen(true);
  }, [forgetSessionPassword, machine]);

  const loadDirectory = useCallback(async (force = false) => {
    if (!machineId || !currentPath) return;
    const request = ++requestRef.current;
    setError(null);
    const cached = force
      ? undefined
      : getCachedDirectory(machineId, currentPath, showHidden);
    if (cached) {
      setListing(cached);
      setLoading(false);
      replaceCurrentPath(cached.path);
      return;
    }
    if (!force) setListing(null);
    setLoading(true);
    try {
      const result = await sshFileService.listDirectory(machineId, currentPath, showHidden);
      cacheDirectory(machineId, currentPath, showHidden, result);
      if (request !== requestRef.current) return;
      setListing(result);
      replaceCurrentPath(result.path);
    } catch (loadError) {
      if (request !== requestRef.current) return;
      const message = getErrorMessage(loadError);
      setListing(null);
      setError(message);
      handleAuthenticationError(message);
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [cacheDirectory, currentPath, getCachedDirectory, handleAuthenticationError, machineId, replaceCurrentPath, showHidden]);

  useEffect(() => {
    void loadDirectory();
  }, [currentPath, loadDirectory]);

  useEffect(() => () => {
    requestRef.current += 1;
  }, []);

  useEffect(() => {
    setPasswordDialogOpen(false);
  }, [machineId]);

  useEffect(() => {
    if (needsPassword) setPasswordDialogOpen(true);
  }, [needsPassword]);

  const closeRemoteFiles = useCallback(() => {
    clear();
    useRightDockStore.setState({ activeView: "git" });
  }, [clear]);

  const handleMachineChange = useCallback((nextMachineId: string) => {
    const nextMachine = machines.find((candidate) => candidate.id === nextMachineId);
    if (nextMachine) openMachine(nextMachine.id, nextMachine.defaultPath);
  }, [machines, openMachine]);

  const handlePasswordConnected = useCallback(async (remember: boolean) => {
    if (!machine) return;
    markSessionPassword(machine.id);
    setPasswordPromptMachineId(null);
    setError(null);
    if (remember) await useSshMachinesStore.getState().load();
    toast.success(t(remember ? "sshFiles.passwordSaved" : "sshFiles.passwordReady"));
    await loadDirectory(true);
  }, [loadDirectory, machine, markSessionPassword, t]);

  const openEntryDialog = useCallback((dialog: EntryDialog) => {
    setEntryDialog(dialog);
    setEntryName(dialog?.kind === "rename" ? dialog.entry.name : "");
  }, []);

  const handleEntryDialogSubmit = useCallback(async () => {
    if (!entryDialog || !machineId || !entryName.trim()) return;
    try {
      if (entryDialog.kind === "file") {
        await sshFileService.createFile(machineId, currentPath, entryName.trim());
      } else if (entryDialog.kind === "directory") {
        await sshFileService.createDirectory(machineId, currentPath, entryName.trim());
      } else {
        await sshFileService.renameEntry(machineId, entryDialog.entry.path, entryName.trim());
      }
      toast.success(t("sshFiles.operationComplete"));
      setEntryDialog(null);
      await loadDirectory(true);
    } catch (operationError) {
      toast.error(getErrorMessage(operationError));
    }
  }, [currentPath, entryDialog, entryName, loadDirectory, machineId, t]);

  const handleDelete = useCallback(async (entry: FsEntry) => {
    if (!machineId) return;
    if (!window.confirm(t("sshFiles.confirmDelete", { name: entry.name }))) return;
    try {
      await sshFileService.deleteEntry(machineId, entry.path);
      toast.success(t("sshFiles.deleted", { name: entry.name }));
      await loadDirectory(true);
    } catch (deleteError) {
      toast.error(getErrorMessage(deleteError));
    }
  }, [loadDirectory, machineId, t]);

  const openFile = useCallback((entry: FsEntry) => {
    if (!machineId || !machine) return;
    useEditorTabsStore.getState().openRemoteFile(
      machineId,
      machine.name,
      entry.path,
      entry.name,
      entry.size,
    );
    useActivityBarStore.setState({
      appViewMode: "files",
      orchestrationOverlayOpen: false,
    });
  }, [machine, machineId]);

  const handleOpen = useCallback((entry: FsEntry) => {
    if (entry.isDir) navigateTo(entry.path);
    else openFile(entry);
  }, [navigateTo, openFile]);

  const handleDownload = useCallback(async (entry: FsEntry) => {
    if (!machineId || entry.isDir) return;
    const destination = await save({ defaultPath: entry.name, title: t("sshFiles.download") });
    if (!destination) return;
    try {
      await sshFileService.downloadFile(machineId, entry.path, destination);
      toast.success(t("sshFiles.downloaded", { name: entry.name }));
    } catch (downloadError) {
      toast.error(getErrorMessage(downloadError));
    }
  }, [machineId, t]);

  const handlePermissionsSubmit = useCallback(async () => {
    if (!machineId || !permissionDialog || !/^[0-7]{3,4}$/.test(permissionDialog.mode)) return;
    try {
      await sshFileService.setPermissions(
        machineId,
        permissionDialog.entry.path,
        Number.parseInt(permissionDialog.mode, 8),
      );
      setPermissionDialog(null);
      toast.success(t("sshFiles.permissionsChanged"));
      await loadDirectory(true);
    } catch (permissionError) {
      toast.error(getErrorMessage(permissionError));
    }
  }, [loadDirectory, machineId, permissionDialog, t]);

  const handleOpenTerminal = useCallback((entry: FsEntry) => {
    if (!machine || !onOpenTerminal || !entry.isDir) return;
    onOpenTerminal(buildTerminalOptions(machine, entry.path));
  }, [machine, onOpenTerminal]);

  const loadTreeDirectory = useCallback(async (path: string) => {
    if (!machineId) return [];
    const cached = getCachedDirectory(machineId, path, showHidden);
    if (cached) return cached.entries;
    try {
      const result = await sshFileService.listDirectory(machineId, path, showHidden);
      cacheDirectory(machineId, path, showHidden, result);
      return result.entries;
    } catch (treeError) {
      const message = getErrorMessage(treeError);
      handleAuthenticationError(message);
      toast.error(message);
      throw treeError;
    }
  }, [cacheDirectory, getCachedDirectory, handleAuthenticationError, machineId, showHidden]);

  if (!machineId || !machine) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-5 text-center">
        <Server className="h-8 w-8 text-[var(--app-text-muted)]" />
        <p className="text-xs text-[var(--app-text-secondary)]">{t("sshFiles.selectMachine")}</p>
        <Button size="sm" variant="outline" onClick={closeRemoteFiles}>{t("sshFiles.close")}</Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="ssh-remote-files-view">
      <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--app-status-success)]" />
            <span className="text-xs font-semibold uppercase tracking-widest text-[var(--app-text-tertiary)]">
              {t("rightDock.remoteFiles")}
            </span>
          </div>
          <div className="mt-0.5 truncate pl-4 text-[10px] text-[var(--app-text-muted)]">
            {machine.user ? `${machine.user}@` : ""}{machine.host}:{machine.port}
          </div>
        </div>

        <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
          <IconButton label={t("goBack")} onClick={goBack} disabled={!canGoBack()}><ArrowLeft className="h-3.5 w-3.5" /></IconButton>
          <IconButton label={t("sshFiles.home")} onClick={() => navigateTo("/")}><Home className="h-3.5 w-3.5" /></IconButton>
          <IconButton label={t(showHidden ? "sshFiles.hideHidden" : "sshFiles.showHidden")} onClick={() => setShowHidden((value) => !value)}>
            {showHidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </IconButton>
          <IconButton label={t("refresh")} onClick={() => void loadDirectory(true)} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </IconButton>
          {viewMode === "tree" && (
            <IconButton label={t("collapseAll")} onClick={() => setTreeResetKey((key) => key + 1)}>
              <ChevronsDownUp className="h-3.5 w-3.5" />
            </IconButton>
          )}
          <IconButton
            label={t(viewMode === "tree" ? "sshFiles.listView" : "sshFiles.treeView")}
            onClick={() => setViewMode(viewMode === "tree" ? "list" : "tree")}
          >
            {viewMode === "tree" ? <LayoutList className="h-3.5 w-3.5" /> : <ListTree className="h-3.5 w-3.5" />}
          </IconButton>
        </div>
      </div>

      <div className="shrink-0 px-3 pb-2">
        <Select value={machineId} onValueChange={handleMachineChange}>
          <SelectTrigger aria-label={t("sshFiles.machine")} className="w-full bg-[var(--app-content)] text-[13px]">
            <SelectValue>{machine.name}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {machines.map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id}>{candidate.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        {needsPassword ? (
          <PanelMessage icon={LockKeyhole} message={t("sshFiles.passwordRequired")}>
            <Button size="sm" variant="outline" onClick={() => setPasswordDialogOpen(true)}>{t("sshFiles.enterPassword")}</Button>
          </PanelMessage>
        ) : loading && !listing ? (
          <PanelMessage icon={Loader2} message={t("sshFiles.loading")} spin />
        ) : error ? (
          <PanelMessage icon={AlertCircle} message={error} danger>
            <Button size="sm" variant="outline" onClick={() => void loadDirectory(true)}>{t("sshFiles.retry")}</Button>
          </PanelMessage>
        ) : listing?.entries.length === 0 && viewMode === "list" ? (
          <PanelMessage icon={FolderOpen} message={t("sshFiles.emptyDirectory")} />
        ) : (
          <SshRemoteFileBrowser
            key={`${machineId}:${currentPath}:${showHidden}:${treeResetKey}`}
            entries={listing?.entries ?? []}
            currentPath={currentPath}
            viewMode={viewMode}
            sortKey={sortKey}
            sortDirection={sortDirection}
            search=""
            onSort={setSort}
            onOpen={handleOpen}
            onRename={(entry) => openEntryDialog({ kind: "rename", entry })}
            onDelete={(entry) => void handleDelete(entry)}
            onDownload={(entry) => void handleDownload(entry)}
            onPermissions={(entry) => setPermissionDialog({
              entry,
              mode: permissionsToOctal(entry.permissions, entry.isDir),
            })}
            onOpenTerminal={handleOpenTerminal}
            onChangeDirectory={changeTerminalDirectory}
            onLoadDirectory={loadTreeDirectory}
          />
        )}
      </div>

      <EntryNameDialog dialog={entryDialog} name={entryName} onNameChange={setEntryName} onClose={() => setEntryDialog(null)} onSubmit={handleEntryDialogSubmit} />
      <PermissionDialog state={permissionDialog} onChange={(mode) => setPermissionDialog((current) => current ? { ...current, mode } : null)} onClose={() => setPermissionDialog(null)} onSubmit={handlePermissionsSubmit} />
      <SshPasswordDialog machine={machine} open={passwordDialogOpen} onOpenChange={setPasswordDialogOpen} onConnected={handlePasswordConnected} />

    </div>
  );
}
