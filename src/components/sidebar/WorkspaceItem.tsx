import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { openPath } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import {
  Folder, ChevronRight, Trash2,
  FolderOpen, FolderSearch, ShieldCheck, Terminal, GitBranch,
  FileText, Settings2,
} from "lucide-react";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger,
  ContextMenuSeparator, ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent,
  ContextMenuCheckboxItem, ContextMenuRadioGroup, ContextMenuRadioItem,
} from "@/components/ui/context-menu";
import { useProvidersStore, useDialogStore } from "@/stores";
import { hooksService, type HookStatus } from "@/services";
import type { Workspace } from "@/types";
import { useState } from "react";

interface WorkspaceItemProps {
  ws: Workspace;
  expanded: boolean;
  children: React.ReactNode;
  onExpand: (wsId: string) => void;
  onOpenTerminal: (path: string, workspaceName?: string, providerId?: string, workspacePath?: string, launchClaude?: boolean) => void;
  onRename: (ws: Workspace) => void;
  onDelete: (ws: Workspace) => void;
  onSetAlias: (ws: Workspace) => void;
  onImportProject: (ws: Workspace) => void;
  onScanImport: (ws: Workspace) => void;
  onGitClone: (ws: Workspace) => void;
  onSetPath: (ws: Workspace) => void;
  onClearPath: (ws: Workspace) => void;
  onSetProvider: (ws: Workspace, providerId: string | null) => void;
}

export default function WorkspaceItem({
  ws, expanded, children,
  onExpand, onOpenTerminal, onRename, onDelete, onSetAlias,
  onImportProject, onScanImport, onGitClone, onSetPath, onClearPath, onSetProvider,
}: WorkspaceItemProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const providerList = useProvidersStore((s) => s.providers);
  const onOpenJournal = useDialogStore((s) => s.openJournal);
  const onOpenSessionCleaner = useDialogStore((s) => s.openSessionCleaner);
  const [hookStatuses, setHookStatuses] = useState<HookStatus[]>([]);

  const displayName = ws.alias || ws.name;
  const rootPath = ws.path || ws.projects[0]?.path;

  const fetchHookStatuses = useCallback(async () => {
    if (!rootPath) return;
    try {
      const statuses = await hooksService.getStatus(rootPath);
      setHookStatuses(statuses);
    } catch {
      setHookStatuses([]);
    }
  }, [rootPath]);

  const handleToggleHook = useCallback(async (hook: HookStatus) => {
    if (!rootPath) return;
    try {
      if (hook.enabled) {
        await hooksService.disableHook(rootPath, hook.name);
      } else {
        await hooksService.enableHook(rootPath, hook.name);
      }
      await fetchHookStatuses();
    } catch (e) {
      toast.error(t("hookOperationFailed", { error: e }));
    }
  }, [rootPath, fetchHookStatuses, t]);

  function getHookLabel(hook: HookStatus): string {
    const labelMap: Record<string, string> = {
      "session-inject": t("hookSessionInject"),
      "plan-archive": t("hookPlanArchive"),
    };
    return labelMap[hook.name] || hook.label;
  }

  const handleRevealFolder = useCallback(async () => {
    if (!rootPath) return;
    try {
      await openPath(rootPath);
    } catch (e) {
      toast.error(t("openFolderFailed", { error: e }));
    }
  }, [rootPath, t]);

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            className={`w-full group flex items-center justify-between px-3 py-2.5 mb-1 rounded-xl transition-all duration-300 ${
              expanded
                ? 'border border-[var(--app-border)] text-[var(--app-accent)]'
                : 'border border-transparent text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]'
            }`}
            style={expanded ? { background: "var(--app-hover)" } : undefined}
            onClick={() => onExpand(ws.id)}
          >
            <div className="flex items-center gap-3">
              <ChevronRight className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`} />
              <span className="text-sm font-medium tracking-wide">{displayName}</span>
              {ws.path && (
                <span className="text-[9px] px-1.5 py-0.5 rounded-full font-medium bg-emerald-100 text-emerald-700 border border-emerald-200 dark:bg-emerald-500/20 dark:text-emerald-300 dark:border-emerald-500/30">
                  Claude
                </span>
              )}
            </div>
            <span
              className="text-xs px-2 py-0.5 rounded-full text-[var(--app-text-secondary)]"
              style={{ background: "var(--app-hover)" }}
            >
              {ws.projects.length}
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          {/* Open Terminal */}
          <ContextMenuItem disabled={ws.projects.length === 0} onClick={() => {
            if (ws.projects.length > 0) onOpenTerminal(ws.projects[0].path, ws.name, ws.providerId);
          }}>
            <Terminal /> {t("openTerminal")}
          </ContextMenuItem>
          {/* Launch Claude Code (with Provider sub-menu) */}
          <ContextMenuSub>
            <ContextMenuSubTrigger disabled={ws.projects.length === 0}>
              <Terminal /> {t("openClaudeCode")}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-48">
              <ContextMenuItem onClick={() => {
                if (ws.projects.length > 0) onOpenTerminal(ws.projects[0].path, ws.name, ws.providerId, ws.path, true);
              }}>
                {t("useWorkspaceProvider")}
                {ws.providerId && providerList.find(p => p.id === ws.providerId) && (
                  <span className="ml-auto text-[10px] opacity-60">
                    {providerList.find(p => p.id === ws.providerId)?.name}
                  </span>
                )}
              </ContextMenuItem>
              {providerList.length > 0 && <ContextMenuSeparator />}
              {providerList.map((p) => (
                <ContextMenuItem
                  key={p.id}
                  onClick={() => {
                    if (ws.projects.length > 0) onOpenTerminal(ws.projects[0].path, ws.name, p.id, ws.path, true);
                  }}
                >
                  {p.name}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
          {/* Open in Explorer */}
          <ContextMenuItem disabled={!rootPath} onClick={handleRevealFolder}>
            <FolderOpen /> {t("openFolder")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          {/* Session Journal */}
          <ContextMenuItem onClick={() => onOpenJournal(ws.name)}>
            <FileText /> {t("sessionJournal")}
          </ContextMenuItem>
          {/* Session Cleaner */}
          <ContextMenuItem onClick={() => onOpenSessionCleaner(ws.name)}>
            <ShieldCheck /> {t("sessionCleaner")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          {/* Import Project (sub-menu: manual / scan / clone) */}
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Folder /> {t("importProject")}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem onClick={() => onImportProject(ws)}>
                {t("importFromDir")}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onScanImport(ws)}>
                <FolderSearch /> {t("importFromDir")}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onGitClone(ws)}>
                <GitBranch /> {t("cloneFromGit")}
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          {/* Workspace Settings (sub-menu) */}
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Settings2 /> {t("settings", { ns: "common" })}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-52">
              {/* Provider */}
              <ContextMenuSub>
                <ContextMenuSubTrigger>Provider</ContextMenuSubTrigger>
                <ContextMenuSubContent className="w-44">
                  <ContextMenuRadioGroup value={ws.providerId ?? ""}>
                    <ContextMenuRadioItem value="" onClick={() => onSetProvider(ws, null)}>
                      {t("noProvider")}
                    </ContextMenuRadioItem>
                    {providerList.length > 0 && <ContextMenuSeparator />}
                    {providerList.map((p) => (
                      <ContextMenuRadioItem key={p.id} value={p.id} onClick={() => onSetProvider(ws, p.id)}>
                        {p.name}
                      </ContextMenuRadioItem>
                    ))}
                  </ContextMenuRadioGroup>
                </ContextMenuSubContent>
              </ContextMenuSub>
              {/* Workspace Path */}
              <ContextMenuItem onClick={() => onSetPath(ws)}>
                {t("setWorkspacePath")}
              </ContextMenuItem>
              {ws.path && (
                <ContextMenuItem onClick={() => onClearPath(ws)}>
                  {t("clearWorkspacePath")}
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
              {/* Alias & Rename */}
              <ContextMenuItem onClick={() => onSetAlias(ws)}>
                {t("setAlias")}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onRename(ws)}>
                {t("renameWorkspace")}
              </ContextMenuItem>
              <ContextMenuSeparator />
              {/* Hooks */}
              <ContextMenuSub>
                <ContextMenuSubTrigger
                  onPointerEnter={() => fetchHookStatuses()}
                >
                  {t("hooks")}
                </ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  {hookStatuses.map((hook) => (
                    <ContextMenuCheckboxItem
                      key={hook.name}
                      checked={hook.enabled}
                      onClick={() => handleToggleHook(hook)}
                    >
                      {getHookLabel(hook)}
                    </ContextMenuCheckboxItem>
                  ))}
                  {hookStatuses.length === 0 && (
                    <ContextMenuItem disabled>Loading...</ContextMenuItem>
                  )}
                </ContextMenuSubContent>
              </ContextMenuSub>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
          {/* Delete Workspace */}
          <ContextMenuItem variant="destructive" onClick={() => onDelete(ws)}>
            <Trash2 /> {t("deleteWorkspace")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {expanded && children}
    </div>
  );
}
