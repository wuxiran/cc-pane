// 资源库 · MCP：一张表列出所有来源，开关决定注入哪些启动档，点行看详情。
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ClipboardPaste, Download, Import, Plus, Search, Server } from "lucide-react";
import { resolveWorkspaceLaunchProfile, toolLabel } from "@/components/providers/launchProfileHelpers";
import RemoteRuntimeNotice from "@/components/providers/RemoteRuntimeNotice";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { workspaceNameForProject } from "@/hooks/useQuickCommandsSync";
import { toastErr, toastInfo, toastOk } from "@/lib/feedback";
import { sharedMcpService } from "@/services";
import { useActivityBarStore, useWorkspacesStore } from "@/stores";
import { useLaunchProfilesStore } from "@/stores/useLaunchProfilesStore";
import { EMPTY_MCP_LAYER, useMcpStore } from "@/stores/useMcpStore";
import { useResourceLibraryStore } from "@/stores/useResourceLibraryStore";
import { useSharedMcpStore } from "@/stores/useSharedMcpStore";
import { mcpTargetKey, type LaunchProfile, type McpLayerTarget } from "@/types";
import type { ClaudeUserMcpServer } from "@/types/shared-mcp";
import { translateError } from "@/utils";
import { handleErrorSilent } from "@/utils/errorHandler";
import LayerMcpEditorDialog, { type LayerEditorRequest } from "./LayerMcpEditorDialog";
import McpDetailPanel from "./McpDetailPanel";
import { buildMcpLibraryEntries, entryDetail, filterMcpLibraryEntries, type McpLibraryEntry } from "./mcpLibraryModel";
import PasteMcpDialog from "./PasteMcpDialog";
import ProfileChips, { type ProfileChipItem } from "./ProfileChips";
import {
  mcpChipState,
  mcpStatusOf,
  setMcpResource,
  visibleProfiles,
  type ChipBlockReason,
  type McpStatusLevel,
  type ProfileMcpResource,
} from "./resourceCenterModel";
import SharedMcpEditorDialog from "./SharedMcpEditorDialog";
import { useProfilePolicyWriter } from "./useProfilePolicyWriter";

const CHOSEN_PROFILES_KEY = "cc-panes.resourceCenter.profiles";
const NO_SCOPE = "__none__";
const STATUS_POLL_MS = 5000;

const STATUS_COLOR: Record<McpStatusLevel, string> = {
  running: "var(--app-status-success)",
  starting: "var(--app-accent)",
  stopped: "var(--app-text-tertiary)",
  failed: "var(--app-status-danger)",
};

function readChosenProfiles(): string[] | null {
  try {
    const raw = localStorage.getItem(CHOSEN_PROFILES_KEY);
    const value: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : null;
  } catch {
    return null;
  }
}

function writeChosenProfiles(ids: readonly string[]) {
  try {
    localStorage.setItem(CHOSEN_PROFILES_KEY, JSON.stringify(ids));
  } catch {
    // 只是显示偏好，存不下就下次回到默认
  }
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function scopeValue(scope: McpLayerTarget | null): string {
  if (scope?.workspaceName) return `ws:${scope.workspaceName}`;
  if (scope?.projectPath) return `project:${scope.projectPath}`;
  return NO_SCOPE;
}

function resourceOf(entry: McpLibraryEntry): ProfileMcpResource | null {
  if (entry.kind === "ccpanes") return { kind: "ccpanes" };
  if (entry.kind === "shared") return { kind: "shared", name: entry.name };
  if (entry.kind === "layer") return { kind: "layer", name: entry.name };
  return null;
}

export default function McpLibraryPage() {
  const { t } = useTranslation("settings");
  const { t: tProviders } = useTranslation("providers");
  const active = useActivityBarStore((s) => s.appViewMode === "resources");
  const scope = useResourceLibraryStore((s) => s.scope);
  const setScope = useResourceLibraryStore((s) => s.setScope);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const loadWorkspaces = useWorkspacesStore((s) => s.load);
  const profiles = useLaunchProfilesStore((s) => s.profiles);
  const loadProfiles = useLaunchProfilesStore((s) => s.load);
  const sharedServers = useSharedMcpStore((s) => s.servers);
  const fetchStatus = useSharedMcpStore((s) => s.fetchStatus);
  const importFromClaude = useSharedMcpStore((s) => s.importFromClaude);
  const loadLayer = useMcpStore((s) => s.loadServers);
  const loadLegacy = useMcpStore((s) => s.loadLegacyServers);
  const importLegacy = useMcpStore((s) => s.importLegacyServers);

  const projectPath = scope?.projectPath ?? null;
  const owningWorkspace = useMemo(
    () => (projectPath ? workspaceNameForProject(workspaces, projectPath) : undefined),
    [workspaces, projectPath],
  );
  const workspaceName = scope?.workspaceName ?? owningWorkspace ?? null;
  const workspaceTarget = useMemo<McpLayerTarget | null>(() => (workspaceName ? { workspaceName } : null), [workspaceName]);
  const projectTarget = useMemo<McpLayerTarget | null>(() => (projectPath ? { projectPath } : null), [projectPath]);
  const workspaceLayer = useMcpStore((s) => (workspaceTarget ? s.layers[mcpTargetKey(workspaceTarget)] ?? EMPTY_MCP_LAYER : EMPTY_MCP_LAYER));
  const projectLayer = useMcpStore((s) => (projectTarget ? s.layers[mcpTargetKey(projectTarget)] ?? EMPTY_MCP_LAYER : EMPTY_MCP_LAYER));

  const [userServers, setUserServers] = useState<ClaudeUserMcpServer[]>([]);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string[] | null>(readChosenProfiles);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ key: string; text: string } | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [sharedEditor, setSharedEditor] = useState<{ name: string | null } | null>(null);
  const [layerEditor, setLayerEditor] = useState<LayerEditorRequest | null>(null);

  const { overlay, apply } = useProfilePolicyWriter((error) => {
    toastErr(t("resourceCenter.saveFailed", { error: translateError(error) }));
    void loadProfiles();
  });

  const loadUserServers = useCallback(() => {
    sharedMcpService.listClaudeUserServers().then(setUserServers).catch((error) => {
      setUserServers([]);
      handleErrorSilent(error, "list claude user mcp servers");
    });
  }, []);

  useEffect(() => {
    if (!active) return;
    // 启动档可能刚在设置窗口改过，两个窗口的 store 不通，回到这里就重读
    const refresh = () => {
      loadProfiles().catch((error) => handleErrorSilent(error, "load launch profiles"));
      loadUserServers();
      void fetchStatus();
    };
    refresh();
    if (useWorkspacesStore.getState().workspaces.length === 0) {
      void Promise.resolve(loadWorkspaces()).catch((error) => handleErrorSilent(error, "load workspaces"));
    }
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(() => void fetchStatus(), STATUS_POLL_MS);
    return () => {
      window.removeEventListener("focus", refresh);
      window.clearInterval(timer);
    };
  }, [active, fetchStatus, loadProfiles, loadUserServers, loadWorkspaces]);

  useEffect(() => {
    if (workspaceTarget) void loadLayer(workspaceTarget);
  }, [workspaceTarget, loadLayer]);
  useEffect(() => {
    if (!projectTarget || !projectPath) return;
    void loadLayer(projectTarget);
    void loadLegacy(projectPath);
  }, [projectTarget, projectPath, loadLayer, loadLegacy]);

  const shown = useMemo(() => visibleProfiles(profiles, chosen), [profiles, chosen]);
  const shownIds = useMemo(() => new Set(shown.map((profile) => profile.id)), [shown]);
  const scopes = useMemo(
    () =>
      workspaces.filter((workspace) => !workspace.archivedAt).flatMap((workspace) => [
        { value: `ws:${workspace.name}`, label: workspace.alias || workspace.name, indent: false },
        ...workspace.projects
          .filter((project) => !project.archivedAt)
          .map((project) => ({ value: `project:${project.path}`, label: project.alias || basename(project.path), indent: true })),
      ]),
    [workspaces],
  );
  // 从 Agent Chat 跳来时 cwd 可能不是已登记的项目，也要能显示和取消
  const scopeOptions = useMemo(() => {
    const value = scopeValue(scope);
    if (value === NO_SCOPE || scopes.some((item) => item.value === value)) return scopes;
    const label = scope?.workspaceName ?? basename(scope?.projectPath ?? "");
    return [...scopes, { value, label, indent: false }];
  }, [scope, scopes]);
  const scopeLabel = scopeOptions.find((item) => item.value === scopeValue(scope))?.label ?? null;

  const entries = useMemo(
    () =>
      buildMcpLibraryEntries({
        sharedServers,
        workspace: workspaceTarget ? { target: workspaceTarget, servers: workspaceLayer.servers } : null,
        project: projectTarget ? { target: projectTarget, servers: projectLayer.servers } : null,
        userServers,
      }),
    [sharedServers, workspaceTarget, workspaceLayer.servers, projectTarget, projectLayer.servers, userServers],
  );
  const visible = useMemo(() => filterMcpLibraryEntries(entries, query), [entries, query]);
  const selected = entries.find((entry) => entry.key === selectedKey) ?? null;
  const legacyPending = useMemo(
    () => Object.keys(projectLayer.legacyServers).filter((name) => !(name in projectLayer.servers)),
    [projectLayer.legacyServers, projectLayer.servers],
  );
  const workspace = useMemo(() => workspaces.find((item) => item.name === workspaceName), [workspaces, workspaceName]);
  const workspaceProfile = useMemo(() => resolveWorkspaceLaunchProfile(workspace, profiles), [workspace, profiles]);

  const profileName = (profile: LaunchProfile) => profile.alias || profile.name;
  const chipsFor = (resource: ProfileMcpResource): ProfileChipItem[] =>
    shown.map((profile) => ({
      profileId: profile.id,
      label: `${profileName(profile)}${profile.targetTools.length === 1 ? ` · ${toolLabel(profile.targetTools[0], tProviders)}` : ""}`,
      state: mcpChipState(overlay[profile.id]?.mcpPolicy ?? profile.mcpPolicy, resource),
    }));

  const handleChipChange = (key: string, resource: ProfileMcpResource) => (profileId: string, on: boolean) => {
    setNotice({ key, text: t("resourceCenter.nextLaunch") });
    apply(profileId, (draft) => setMcpResource(draft, resource, on));
  };
  const handleBlocked = (key: string) => (reason: ChipBlockReason, profileId: string) => {
    const profile = shown.find((item) => item.id === profileId);
    setNotice({ key, text: t(`resourceCenter.blocked.${reason}`, { name: profile ? profileName(profile) : "" }) });
  };
  const toggleShown = (id: string, on: boolean) => {
    const next = on ? [...shownIds, id] : [...shownIds].filter((item) => item !== id);
    if (next.length === 0) return;
    setChosen(next);
    writeChosenProfiles(next);
  };

  const handleImportClaude = async () => {
    try {
      const imported = await importFromClaude();
      if (imported.length > 0) toastOk(t("sharedMcp.importedCount", { count: imported.length }));
      else toastInfo(t("sharedMcp.noNewServers"));
    } catch (error) {
      toastErr(t("sharedMcp.importFailed", { error: translateError(error) }));
    }
  };
  const handleImportLegacy = async () => {
    if (!projectPath) return;
    try {
      const imported = await importLegacy(projectPath, owningWorkspace);
      toastOk(t("sharedMcp.importedCount", { count: imported.length }));
      await loadLegacy(projectPath);
    } catch (error) {
      toastErr(t("sharedMcp.importFailed", { error: translateError(error) }));
    }
  };

  const onScopeChange = (value: string) => {
    if (value.startsWith("ws:")) setScope({ workspaceName: value.slice(3) });
    else if (value.startsWith("project:")) setScope({ projectPath: value.slice(8) });
    else setScope(null);
    setSelectedKey(null);
  };

  const sourceLabel = (entry: McpLibraryEntry) =>
    entry.kind === "ccpanes" ? t("mcpSourceCcpanes")
      : entry.kind === "shared" ? t("mcpSourceShared")
        : entry.kind === "user" ? t("resourceLibrary.sourceUser")
          : entry.layer === "workspace" ? t("mcpSourceWorkspace") : t("mcpSourceProject");

  return (
    <div className="flex h-full" data-testid="mcp-library-page" style={{ background: "var(--app-panel-bg)" }}>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 flex-wrap items-center gap-2 px-6 pb-3 pt-5">
          <h1 className="mr-auto text-[length:var(--text-title)] font-semibold" style={{ color: "var(--app-text-primary)" }}>{t("resourceLibrary.mcp")}</h1>
          <div className="relative">
            <Search size={13} aria-hidden="true" className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2" style={{ color: "var(--app-text-tertiary)" }} />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("resourceLibrary.search")}
              aria-label={t("resourceLibrary.search")}
              className="h-8 w-44 pl-7 text-xs"
            />
          </div>
          <Select value={scopeValue(scope)} onValueChange={onScopeChange}>
            <SelectTrigger className="h-8 w-48 text-xs" aria-label={t("resourceCenter.scope")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_SCOPE}>{t("resourceCenter.scopeNone")}</SelectItem>
              {scopeOptions.map((item) => (
                <SelectItem key={item.value} value={item.value} className={item.indent ? "pl-6" : undefined}>{item.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {profiles.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" className="h-8 text-xs">
                  {t("resourceCenter.shownProfiles", { shown: shown.length, total: profiles.length })}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {profiles.map((profile) => (
                  <DropdownMenuCheckboxItem
                    key={profile.id}
                    checked={shownIds.has(profile.id)}
                    onCheckedChange={(checked) => toggleShown(profile.id, checked === true)}
                    onSelect={(event) => event.preventDefault()}
                  >
                    {profileName(profile)}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" className="h-8" data-testid="mcp-add-menu">
                <Plus size={13} className="mr-1" />
                {t("resourceLibrary.add")}
                <ChevronDown size={13} className="ml-1" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setPasteOpen(true)}><ClipboardPaste />{t("resourceCenter.paste.open")}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setSharedEditor({ name: null })}><Plus />{t("resourceLibrary.addShared")}</DropdownMenuItem>
              {workspaceTarget && !projectTarget && (
                <DropdownMenuItem onSelect={() => setLayerEditor({ target: workspaceTarget, layer: "workspace" })}><Plus />{t("resourceLibrary.addLayer", { name: scopeLabel ?? "" })}</DropdownMenuItem>
              )}
              {projectTarget && (
                <DropdownMenuItem onSelect={() => setLayerEditor({ target: projectTarget, layer: "project" })}><Plus />{t("resourceLibrary.addLayer", { name: scopeLabel ?? "" })}</DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void handleImportClaude()}><Download />{t("resourceLibrary.importUser")}</DropdownMenuItem>
              {legacyPending.length > 0 && (
                <DropdownMenuItem onSelect={() => void handleImportLegacy()}><Import />{t("resourceLibrary.importLegacy", { count: legacyPending.length })}</DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          <RemoteRuntimeNotice workspace={workspace} profile={workspaceProfile} subject="mcp" className="mb-3" />
          {profiles.length === 0 && <p className="mb-2 text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("resourceCenter.noProfiles")}</p>}
          {visible.length === 0 ? (
            <EmptyState icon={Server} title={t("resourceLibrary.noMatch")} />
          ) : (
            <div className="divide-y rounded-lg border" style={{ borderColor: "var(--app-border)" }}>
              {visible.map((entry) => {
                const resource = resourceOf(entry);
                const chips = resource ? chipsFor(resource) : [];
                const status = entry.kind === "shared" ? mcpStatusOf(entry.server.status) : null;
                const notInjected = status !== null && status.level !== "running" && status.level !== "starting" && chips.some((chip) => chip.state.on);
                return (
                  <McpRow
                    key={entry.key}
                    entry={entry}
                    source={sourceLabel(entry)}
                    current={entry.key === selectedKey}
                    onSelect={() => setSelectedKey(entry.key === selectedKey ? null : entry.key)}
                    status={status && <span style={{ color: STATUS_COLOR[status.level] }}>{t(`mcpStatus.${status.level}`)}</span>}
                    warning={notInjected ? t("resourceLibrary.notInjected") : entry.kind === "layer" && entry.shadowed ? t("resourceLibrary.shadowed") : null}
                    notice={notice?.key === entry.key ? notice.text : null}
                    trailing={
                      resource ? (
                        <ProfileChips
                          resourceName={entry.name}
                          items={chips}
                          onChange={handleChipChange(entry.key, resource)}
                          onBlocked={handleBlocked(entry.key)}
                        />
                      ) : (
                        <span className="text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>{t("resourceLibrary.userNotControlled")}</span>
                      )
                    }
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>

      {selected && (
        <McpDetailPanel
          entry={selected}
          sourceLabel={sourceLabel(selected)}
          onClose={() => setSelectedKey(null)}
          onEditShared={(name) => setSharedEditor({ name })}
          onEditLayer={setLayerEditor}
          onImportUser={() => void handleImportClaude()}
        />
      )}

      <PasteMcpDialog open={pasteOpen} onOpenChange={setPasteOpen} layerTarget={projectTarget ?? workspaceTarget} layerLabel={scopeLabel} />
      <SharedMcpEditorDialog
        open={sharedEditor !== null}
        server={sharedServers.find((server) => server.name === sharedEditor?.name) ?? null}
        onOpenChange={(open) => { if (!open) setSharedEditor(null); }}
      />
      {layerEditor && <LayerMcpEditorDialog request={layerEditor} onClose={() => setLayerEditor(null)} />}
    </div>
  );
}

function McpRow({
  entry,
  source,
  current,
  onSelect,
  status,
  warning,
  notice,
  trailing,
}: {
  entry: McpLibraryEntry;
  source: string;
  current: boolean;
  onSelect: () => void;
  status: React.ReactNode;
  warning: string | null;
  notice: string | null;
  trailing: React.ReactNode;
}) {
  const detail = entryDetail(entry);
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2 transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] data-[current=true]:bg-[var(--app-active-bg)]"
      data-testid="mcp-library-row"
      data-resource-name={entry.name}
      data-current={current ? "true" : undefined}
    >
      <button type="button" aria-expanded={current} className="min-w-48 flex-1 text-left" onClick={onSelect}>
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-[length:var(--text-row)] font-medium" style={{ color: "var(--app-text-primary)" }}>{entry.name}</span>
          <span className="text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>{source}</span>
          {status && <span className="text-[length:var(--text-micro)]">{status}</span>}
        </span>
        {detail && <span className="mt-0.5 block truncate font-mono text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>{detail}</span>}
        {warning && <span className="mt-0.5 block text-[length:var(--text-micro)]" style={{ color: "var(--app-status-warning, var(--app-text-tertiary))" }}>{warning}</span>}
        {notice && <span role="status" className="mt-0.5 block text-[length:var(--text-micro)]" style={{ color: "var(--app-text-secondary)" }}>{notice}</span>}
      </button>
      {trailing}
    </div>
  );
}
