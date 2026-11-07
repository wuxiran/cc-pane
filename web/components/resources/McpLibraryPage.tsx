// 资源库 · MCP：一张表列出所有来源，开关决定注入哪些启动档，点行看详情。
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ClipboardPaste, Compass, FolderOpen, Import, Plus, Search, Server } from "lucide-react";
import { resolveWorkspaceLaunchProfile } from "@/components/providers/launchProfileHelpers";
import RemoteRuntimeNotice from "@/components/providers/RemoteRuntimeNotice";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/input";
import { toastErr, toastOk } from "@/lib/feedback";
import { settingsService } from "@/services";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useActivityBarStore } from "@/stores";
import { EMPTY_MCP_LAYER, useMcpStore } from "@/stores/useMcpStore";
import { useSharedMcpStore } from "@/stores/useSharedMcpStore";
import { mcpTargetKey, type McpLayerTarget } from "@/types";
import { translateError } from "@/utils";
import AgentMcpServersSection from "./AgentMcpServersSection";
import LayerMcpEditorDialog, { type LayerEditorRequest } from "./LayerMcpEditorDialog";
import { profileChipLabel, profileName, ScopeSelect, ShownProfilesMenu, useLibraryProfiles, useResourceScope, useScopeOptions } from "./libraryChrome";
import McpDetailPanel from "./McpDetailPanel";
import { buildMcpLibraryEntries, entryDetail, filterMcpLibraryEntries, type McpLibraryEntry } from "./mcpLibraryModel";
import PasteMcpDialog from "./PasteMcpDialog";
import ProfileChips, { type ProfileChipItem } from "./ProfileChips";
import {
  mcpChipState,
  mcpStatusOf,
  remoteUnsupportedByProfile,
  setMcpResource,
  type ChipBlockReason,
  type McpStatusLevel,
  type ProfileMcpResource,
} from "./resourceCenterModel";
import SharedMcpEditorDialog from "./SharedMcpEditorDialog";

// 市场带 500 条快照逻辑和卡片，首屏用不到，单独分包
const McpMarketSection = lazy(() => import("./McpMarketSection"));

const STATUS_POLL_MS = 5000;
/** 条目少时用眼睛扫比搜索快，搜索框只在列表变长后出现 */
const SEARCH_THRESHOLD = 8;

const STATUS_COLOR: Record<McpStatusLevel, string> = {
  running: "var(--app-status-success)",
  starting: "var(--app-accent)",
  stopped: "var(--app-text-tertiary)",
  failed: "var(--app-status-danger)",
};

function resourceOf(entry: McpLibraryEntry): ProfileMcpResource {
  if (entry.kind === "ccpanes") return { kind: "ccpanes" };
  if (entry.kind === "shared") return { kind: "shared", name: entry.name };
  return { kind: "layer", name: entry.name };
}

export default function McpLibraryPage() {
  const { t } = useTranslation("settings");
  const { t: tProviders } = useTranslation("providers");
  const active = useActivityBarStore((s) => s.appViewMode === "resources");
  const { projectPath, owningWorkspace, workspaceName, workspace } = useResourceScope();
  const { label: scopeLabel } = useScopeOptions();
  const { profiles, shown, toggleShown, shownIds, overlay, apply } = useLibraryProfiles(active);
  const sharedServers = useSharedMcpStore((s) => s.servers);
  const fetchStatus = useSharedMcpStore((s) => s.fetchStatus);
  const loadLayer = useMcpStore((s) => s.loadServers);
  const loadLegacy = useMcpStore((s) => s.loadLegacyServers);
  const importLegacy = useMcpStore((s) => s.importLegacyServers);

  const workspaceTarget = useMemo<McpLayerTarget | null>(() => (workspaceName ? { workspaceName } : null), [workspaceName]);
  const projectTarget = useMemo<McpLayerTarget | null>(() => (projectPath ? { projectPath } : null), [projectPath]);
  const workspaceLayer = useMcpStore((s) => (workspaceTarget ? s.layers[mcpTargetKey(workspaceTarget)] ?? EMPTY_MCP_LAYER : EMPTY_MCP_LAYER));
  const projectLayer = useMcpStore((s) => (projectTarget ? s.layers[mcpTargetKey(projectTarget)] ?? EMPTY_MCP_LAYER : EMPTY_MCP_LAYER));

  const marketRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ key: string; text: string } | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [sharedEditor, setSharedEditor] = useState<{ name: string | null } | null>(null);
  const [layerEditor, setLayerEditor] = useState<LayerEditorRequest | null>(null);

  useEffect(() => {
    if (!active) return;
    const refresh = () => void fetchStatus();
    refresh();
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, STATUS_POLL_MS);
    return () => {
      window.removeEventListener("focus", refresh);
      window.clearInterval(timer);
    };
  }, [active, fetchStatus]);

  useEffect(() => {
    if (workspaceTarget) void loadLayer(workspaceTarget);
  }, [workspaceTarget, loadLayer]);
  useEffect(() => {
    if (!projectTarget || !projectPath) return;
    void loadLayer(projectTarget);
    void loadLegacy(projectPath);
  }, [projectTarget, projectPath, loadLayer, loadLegacy]);


  const entries = useMemo(
    () =>
      buildMcpLibraryEntries({
        sharedServers,
        workspace: workspaceTarget ? { target: workspaceTarget, servers: workspaceLayer.servers } : null,
        project: projectTarget ? { target: projectTarget, servers: projectLayer.servers } : null,
      }),
    [sharedServers, workspaceTarget, workspaceLayer.servers, projectTarget, projectLayer.servers],
  );
  const visible = useMemo(() => filterMcpLibraryEntries(entries, query), [entries, query]);
  const selected = entries.find((entry) => entry.key === selectedKey) ?? null;
  const legacyPending = useMemo(
    () => Object.keys(projectLayer.legacyServers).filter((name) => !(name in projectLayer.servers)),
    [projectLayer.legacyServers, projectLayer.servers],
  );
  const workspaceProfile = useMemo(() => resolveWorkspaceLaunchProfile(workspace, profiles), [workspace, profiles]);

  const chipsFor = (entry: McpLibraryEntry): ProfileChipItem[] => {
    const resource = resourceOf(entry);
    const remote = entry.kind === "shared" ? entry.server.config.remote : null;
    return shown.map((profile) => ({
      profileId: profile.id,
      label: profileChipLabel(profile, tProviders),
      state: remote && remoteUnsupportedByProfile(profile, remote)
        ? { on: false, blocked: "remoteUnsupported" }
        : mcpChipState(overlay[profile.id]?.mcpPolicy ?? profile.mcpPolicy, resource),
    }));
  };

  const handleChipChange = (key: string, resource: ProfileMcpResource) => (profileId: string, on: boolean) => {
    setNotice({ key, text: t("resourceCenter.nextLaunch") });
    apply(profileId, (draft) => setMcpResource(draft, resource, on));
  };
  const handleBlocked = (key: string) => (reason: ChipBlockReason, profileId: string) => {
    const profile = shown.find((item) => item.id === profileId);
    setNotice({ key, text: t(`resourceCenter.blocked.${reason}`, { name: profile ? profileName(profile) : "" }) });
  };
  const openFolder = async () => {
    try {
      const info = await settingsService.getDataDirInfo();
      await revealItemInDir(`${info.currentPath}/shared-mcp.json`);
    } catch (error) {
      toastErr(t("resourceCenter.saveFailed", { error: translateError(error) }));
    }
  };
  const scrollToMarket = () => {
    marketRef.current?.scrollIntoView({ block: "start" });
    marketRef.current?.querySelector("input")?.focus();
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

  const sourceLabel = (entry: McpLibraryEntry) =>
    entry.kind === "ccpanes" ? t("mcpSourceCcpanes")
      : entry.kind === "shared" ? t("mcpSourceShared")
        : entry.layer === "workspace" ? t("mcpSourceWorkspace") : t("mcpSourceProject");

  return (
    <div className="flex h-full" data-testid="mcp-library-page" style={{ background: "var(--app-panel-bg)" }}>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 flex-wrap items-center gap-2 px-6 pb-3 pt-5">
          <h1 className="mr-auto text-[length:var(--text-title)] font-semibold" style={{ color: "var(--app-text-primary)" }}>{t("resourceLibrary.mcp")}</h1>
          <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={scrollToMarket}><Compass size={13} className="mr-1" />{t("resourceLibrary.discover")}</Button>
          <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => void openFolder()}><FolderOpen size={13} className="mr-1" />{t("resourceLibrary.folder")}</Button>
          <ScopeSelect onChange={() => setSelectedKey(null)} />
          <ShownProfilesMenu profiles={profiles} shownIds={shownIds} onToggle={toggleShown} />
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
              {legacyPending.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => void handleImportLegacy()}><Import />{t("resourceLibrary.importLegacy", { count: legacyPending.length })}</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          <RemoteRuntimeNotice workspace={workspace} profile={workspaceProfile} subject="mcp" className="mb-3" />
          <p className="mb-3 text-xs leading-relaxed" style={{ color: "var(--app-text-tertiary)" }}>{t("resourceLibrary.mcpIntro")}</p>
          {profiles.length === 0 && <p className="mb-2 text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("resourceCenter.noProfiles")}</p>}
          {entries.length > SEARCH_THRESHOLD && (
            <div className="relative mb-2">
              <Search size={13} aria-hidden="true" className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2" style={{ color: "var(--app-text-tertiary)" }} />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("resourceLibrary.search")}
                aria-label={t("resourceLibrary.search")}
                className="h-8 pl-7 text-xs"
              />
            </div>
          )}
          {visible.length === 0 ? (
            <EmptyState icon={Server} title={t("resourceLibrary.noMatch")} />
          ) : (
            <div className="divide-y rounded-lg border" style={{ borderColor: "var(--app-border)" }}>
              {visible.map((entry) => {
                const chips = chipsFor(entry);
                const resource = resourceOf(entry);
                const remote = entry.kind === "shared" && Boolean(entry.server.config.remote);
                const status = entry.kind === "shared" && !remote ? mcpStatusOf(entry.server.status) : null;
                const notInjected = status !== null && status.level !== "running" && status.level !== "starting" && chips.some((chip) => chip.state.on);
                return (
                  <McpRow
                    key={entry.key}
                    entry={entry}
                    source={sourceLabel(entry)}
                    current={entry.key === selectedKey}
                    onSelect={() => setSelectedKey(entry.key === selectedKey ? null : entry.key)}
                    status={remote ? <span style={{ color: "var(--app-text-tertiary)" }}>{t("resourceLibrary.remote")}</span> : status && <span style={{ color: STATUS_COLOR[status.level] }}>{t(`mcpStatus.${status.level}`)}</span>}
                    warning={notInjected ? t("resourceLibrary.notInjected") : entry.kind === "layer" && entry.shadowed ? t("resourceLibrary.shadowed") : null}
                    notice={notice?.key === entry.key ? notice.text : null}
                    trailing={
                      <ProfileChips
                        resourceName={entry.name}
                        items={chips}
                        onChange={handleChipChange(entry.key, resource)}
                        onBlocked={handleBlocked(entry.key)}
                      />
                    }
                  />
                );
              })}
            </div>
          )}
          {sharedServers.length === 0 && !query && (
            <div
              className="mt-3 flex flex-col items-center gap-1 rounded-lg border border-dashed px-4 py-8 text-center"
              style={{ borderColor: "var(--app-border)" }}
              data-testid="mcp-empty-card"
            >
              <p className="text-[length:var(--text-row)] font-medium" style={{ color: "var(--app-text-primary)" }}>{t("resourceLibrary.emptyTitle")}</p>
              <p className="text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("resourceLibrary.emptyHint")}</p>
              <Button size="sm" variant="outline" className="mt-2 h-8" onClick={() => setSharedEditor({ name: null })}>
                <Plus size={13} className="mr-1" />{t("resourceLibrary.addServer")}
              </Button>
            </div>
          )}
          <AgentMcpServersSection active={active} />
          <div ref={marketRef} className="mt-6 scroll-mt-2">
            <Suspense fallback={null}>
              <McpMarketSection active={active} />
            </Suspense>
          </div>
        </div>
      </div>

      {selected && (
        <McpDetailPanel
          entry={selected}
          sourceLabel={sourceLabel(selected)}
          onClose={() => setSelectedKey(null)}
          onEditShared={(name) => setSharedEditor({ name })}
          onEditLayer={setLayerEditor}
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
