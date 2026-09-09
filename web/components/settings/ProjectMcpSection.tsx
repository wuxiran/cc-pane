// MCP 有效集页（工作空间层 / 项目覆盖层）：会话实际会连上的 MCP 摊成一张卡片网格。
// 启动档注入的（内置 ccpanes + 共享服务）给开关写回启动档；本层 mcp.json 的给编辑 / 删除。
import { useState, useEffect, useCallback, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toastErr, toastOk } from "@/lib/feedback";
import { Import, Loader2, Pencil, Play, Plus, Server, Square, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/form-field";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DescriptionLangToggle } from "@/components/ui/DescriptionLangToggle";
import { resolveWorkspaceLaunchProfile, toDraft } from "@/components/providers/launchProfileHelpers";
import { nextToggleServer } from "@/components/providers/launchProfileSkillPolicy";
import { iconGlyph, toneFor } from "@/components/skillmarket/skillMarketModel";
import { useMcpStore, useWorkspacesStore } from "@/stores";
import { useLaunchProfilesStore } from "@/stores/useLaunchProfilesStore";
import { useSharedMcpStore } from "@/stores/useSharedMcpStore";
import { workspaceNameForProject } from "@/hooks/useQuickCommandsSync";
import { useDescriptionLang } from "@/hooks/useDescriptionLang";
import type { LaunchProfileDraft, McpLayerTarget, McpServerConfig } from "@/types";
import { sharedMcpFailureMessage } from "@/types/shared-mcp";
import { parseEnvLines, formatEnvLines, translateError } from "@/utils";
import { handleErrorSilent } from "@/utils/errorHandler";
import ScopeBanner from "./ScopeBanner";
import RemoteRuntimeNotice from "@/components/providers/RemoteRuntimeNotice";
import {
  buildMcpHubEntries,
  commandLine,
  filterMcpHubEntries,
  injectedCount,
  sharedStatusKey,
  type McpHubEntry,
  type McpHubFilter,
} from "./mcpHubModel";

interface FormState {
  name: string;
  command: string;
  args: string;
  env: string;
  descriptionZh: string;
  descriptionEn: string;
}

const emptyForm: FormState = {
  name: "",
  command: "",
  args: "",
  env: "",
  descriptionZh: "",
  descriptionEn: "",
};

function descriptionsFromForm(form: FormState): Record<string, string> {
  return {
    "zh-CN": form.descriptionZh.trim(),
    en: form.descriptionEn.trim(),
  };
}

interface ProjectMcpSectionProps {
  projectPath: string;
  /** 工作空间视图（docs/98 workspace-first）：projectPath 为空时生效 */
  workspaceName?: string;
}

export default function ProjectMcpSection({
  projectPath,
  workspaceName,
}: ProjectMcpSectionProps) {
  const { t } = useTranslation("settings");
  const { t: tCommon } = useTranslation("common");
  const { t: tProviders } = useTranslation("providers");
  const { t: tNotify } = useTranslation("notifications");
  const { describe } = useDescriptionLang();

  const workspaceMode = !projectPath && !!workspaceName;
  const layer = workspaceMode ? "workspace" : "project";
  const target = useMemo<McpLayerTarget>(
    () => (workspaceMode ? { workspaceName: workspaceName! } : { projectPath }),
    [workspaceMode, workspaceName, projectPath],
  );
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  // 项目视图里旧配置默认导入到项目所属工作空间；找不到所属工作空间则导入到项目覆盖层
  const owningWorkspace = useMemo(
    () => (workspaceMode ? undefined : workspaceNameForProject(workspaces, projectPath)),
    [workspaceMode, workspaces, projectPath],
  );
  const profileWorkspaceName = workspaceMode ? workspaceName : owningWorkspace;
  const workspace = useMemo(
    () => workspaces.find((item) => item.name === profileWorkspaceName),
    [workspaces, profileWorkspaceName],
  );

  const servers = useMcpStore((s) => s.servers);
  const legacyServers = useMcpStore((s) => s.legacyServers);
  const loading = useMcpStore((s) => s.loading);
  const loadServers = useMcpStore((s) => s.loadServers);
  const loadLegacyServers = useMcpStore((s) => s.loadLegacyServers);
  const importLegacyServers = useMcpStore((s) => s.importLegacyServers);
  const upsertServer = useMcpStore((s) => s.upsertServer);
  const removeServer = useMcpStore((s) => s.removeServer);

  const profiles = useLaunchProfilesStore((s) => s.profiles);
  const loadProfiles = useLaunchProfilesStore((s) => s.load);
  const updateProfile = useLaunchProfilesStore((s) => s.update);
  const sharedServers = useSharedMcpStore((s) => s.servers);
  const fetchSharedStatus = useSharedMcpStore((s) => s.fetchStatus);
  const startShared = useSharedMcpStore((s) => s.startServer);
  const stopShared = useSharedMcpStore((s) => s.stopServer);

  const [filter, setFilter] = useState<McpHubFilter>("all");
  const [editing, setEditing] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>({ ...emptyForm });
  const [importing, setImporting] = useState(false);
  const [sharedBusy, setSharedBusy] = useState<string | null>(null);

  useEffect(() => {
    loadServers(target);
    if (!workspaceMode) loadLegacyServers(projectPath);
  }, [target, workspaceMode, projectPath, loadServers, loadLegacyServers]);

  useEffect(() => {
    loadProfiles().catch((error) => handleErrorSilent(error, "load launch profiles"));
    void fetchSharedStatus();
  }, [loadProfiles, fetchSharedStatus]);

  const profile = useMemo(() => resolveWorkspaceLaunchProfile(workspace, profiles), [workspace, profiles]);
  const entries = useMemo(
    () => buildMcpHubEntries({ profile, sharedServers, layerServers: servers, layer }),
    [profile, sharedServers, servers, layer],
  );
  const visible = useMemo(() => filterMcpHubEntries(entries, filter), [entries, filter]);
  const layerCount = Object.keys(servers).length;
  const injected = injectedCount(entries);
  const profileLabel = profile?.alias || profile?.name || "";
  const policy = profile?.mcpPolicy;
  const profileNotice = !profile
    ? t("mcpProfileNoProfile")
    : policy?.mode === "disabled"
      ? t("mcpProfileDisabled", { name: profileLabel })
      : policy && !policy.includeSharedMcp && sharedServers.length > 0
        ? t("mcpProfileSharedOff", { name: profileLabel })
        : null;

  const legacyPending = useMemo(
    () => Object.keys(legacyServers).filter((name) => !(name in servers)),
    [legacyServers, servers],
  );

  async function handleImportLegacy() {
    setImporting(true);
    try {
      const imported = await importLegacyServers(projectPath, owningWorkspace);
      toastOk(tNotify("mcpLegacyImported", { count: imported.length }));
      await loadLegacyServers(projectPath);
    } catch (e) {
      toastErr(tNotify("operationFailed", { error: translateError(e) }));
    } finally {
      setImporting(false);
    }
  }

  const resetForm = useCallback(() => {
    setForm({ ...emptyForm });
    setEditing(false);
    setEditingName(null);
  }, []);

  function handleNew() {
    setForm({ ...emptyForm });
    setEditingName(null);
    setEditing(true);
  }

  function handleEdit(name: string, config: McpServerConfig) {
    setEditingName(name);
    setForm({
      name,
      command: config.command,
      args: config.args.join(" "),
      env: formatEnvLines(config.env),
      descriptionZh: config.descriptions?.["zh-CN"] ?? "",
      descriptionEn: config.descriptions?.en ?? "",
    });
    setEditing(true);
  }

  async function handleSave() {
    if (!form.name.trim() || !form.command.trim()) {
      toastErr(tNotify("mcpNameCommandRequired"));
      return;
    }
    try {
      const args = form.args.trim() ? form.args.trim().split(/\s+/) : [];
      const env = parseEnvLines(form.env);
      if (editingName && editingName !== form.name.trim()) {
        await removeServer(target, editingName);
      }
      await upsertServer(target, form.name.trim(), form.command.trim(), args, env, descriptionsFromForm(form));
      toastOk(tNotify(editingName ? "mcpServerUpdated" : "mcpServerAdded"));
      resetForm();
    } catch (e) {
      toastErr(tNotify("operationFailed", { error: translateError(e) }));
    }
  }

  async function handleDelete(name: string) {
    try {
      await removeServer(target, name);
      toastOk(tNotify("mcpServerDeleted"));
      if (editingName === name) resetForm();
    } catch (e) {
      toastErr(tNotify("operationFailed", { error: translateError(e) }));
    }
  }

  const patchProfile = async (mutate: (draft: LaunchProfileDraft) => LaunchProfileDraft) => {
    if (!profile) return;
    try {
      await updateProfile(profile.id, mutate(toDraft(profile)));
    } catch (error) {
      toastErr(tNotify("operationFailed", { error: translateError(error) }));
    }
  };

  const toggleEntry = (entry: McpHubEntry) => {
    if (entry.kind === "ccpanes") {
      void patchProfile((draft) => ({
        ...draft,
        mcpPolicy: { ...draft.mcpPolicy, includeCcpanesMcp: !draft.mcpPolicy.includeCcpanesMcp },
      }));
    } else if (entry.kind === "shared") {
      void patchProfile((draft) => nextToggleServer(draft, entry.name));
    }
  };

  const runShared = async (name: string, running: boolean) => {
    setSharedBusy(name);
    try {
      await (running ? stopShared(name) : startShared(name));
    } catch (error) {
      toastErr(tNotify("operationFailed", { error: translateError(error) }));
    } finally {
      setSharedBusy(null);
    }
  };

  const layerHint = workspaceMode ? t("mcpLayerWorkspaceHint") : t("mcpLayerProjectHint");
  const sourceLabel = (entry: McpHubEntry) =>
    entry.kind === "ccpanes"
      ? t("mcpSourceCcpanes")
      : entry.kind === "shared"
        ? t("mcpSourceShared")
        : entry.layer === "workspace"
          ? t("mcpSourceWorkspace")
          : t("mcpSourceProject");

  return (
    <div className="flex h-full flex-col" data-testid="project-mcp-section">
      <header className="shrink-0 px-6 pb-3 pt-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-[15px] font-semibold" style={{ color: "var(--app-text-primary)" }}>
              <Server size={16} style={{ color: "var(--app-accent)" }} />
              <span className="truncate">{t("mcpTitle")}</span>
              <Badge variant="outline" className="max-w-48 truncate text-[10px] font-normal" title={workspaceMode ? workspaceName : projectPath}>
                {workspaceMode ? t("mcpLayerWorkspace", { name: workspaceName }) : t("mcpLayerProject")}
              </Badge>
            </h1>
            <p className="mt-1 text-[12px] leading-relaxed" style={{ color: "var(--app-text-tertiary)" }}>
              {t("mcpHubSummary", { injected, layer: layerCount })}
              {profile && (
                <>
                  {" · "}
                  {t("mcpProfileHint", { name: profileLabel })}
                </>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <DescriptionLangToggle className="mr-1" />
            <Button size="sm" className="h-8" onClick={handleNew}>
              <Plus size={13} className="mr-1.5" />
              {t("mcpAdd")}
            </Button>
          </div>
        </div>
      </header>

      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        {workspaceMode && (
          <div className="mb-4">
            <ScopeBanner
              scope="workspace"
              descriptionKey="scope.mcpWorkspaceDesc"
              link={{ labelKey: "scope.editGlobalMcp", paneId: "shared-mcp" }}
            />
          </div>
        )}
        <div className="mb-4 flex flex-wrap items-center gap-1.5" role="tablist" aria-label={t("mcpTitle")}>
          <FilterChip active={filter === "all"} label={t("mcpFilterAll")} onClick={() => setFilter("all")} />
          <FilterChip
            active={filter === "profile"}
            label={`${t("mcpProfileSection")} ${injected}`}
            onClick={() => setFilter("profile")}
          />
          <FilterChip
            active={filter === "layer"}
            label={`${t("mcpOwnSection")} ${layerCount}`}
            onClick={() => setFilter("layer")}
          />
        </div>

        {profileNotice && filter !== "layer" && (
          <p className="mb-3 text-[12px]" style={{ color: "var(--app-status-warning, var(--app-text-tertiary))" }}>
            {profileNotice}
          </p>
        )}

        <RemoteRuntimeNotice workspace={workspace} profile={profile} subject="mcp" className="mb-4" />

        {!workspaceMode && legacyPending.length > 0 && (
          <div className="mb-4 flex items-start gap-3 rounded-lg border border-border bg-muted/40 p-3">
            <Import size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-xs">{t("mcpLegacyFound", { count: legacyPending.length })}</p>
              <p className="truncate font-mono text-xs text-muted-foreground">{legacyPending.join(", ")}</p>
            </div>
            <Button size="sm" variant="secondary" disabled={importing} onClick={handleImportLegacy}>
              {importing ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Import size={14} className="mr-1" />}
              {owningWorkspace
                ? t("mcpLegacyImportToWorkspace", { name: owningWorkspace })
                : t("mcpLegacyImportToProject")}
            </Button>
          </div>
        )}

        {loading && layerCount === 0 ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 size={16} className="animate-spin" />
            <span>{tCommon("loading")}</span>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
            {visible.map((entry) => (
              <McpCard
                key={`${entry.kind}:${entry.name}`}
                entry={entry}
                source={sourceLabel(entry)}
                description={
                  entry.kind === "ccpanes"
                    ? tProviders("ccpanesMcpDesc")
                    : entry.kind === "layer"
                      ? describe(entry.config.descriptions)
                      : null
                }
                busy={entry.kind === "shared" && sharedBusy === entry.name}
                onToggle={() => toggleEntry(entry)}
                onRun={(running) => void runShared(entry.name, running)}
                onEdit={() => entry.kind === "layer" && handleEdit(entry.name, entry.config)}
                onDelete={() => void handleDelete(entry.name)}
              />
            ))}
            {filter !== "profile" && (
              <button
                type="button"
                onClick={handleNew}
                className="flex min-h-[132px] flex-col items-start justify-center gap-1 rounded-xl border border-dashed px-4 text-left transition-colors hover:border-[var(--app-home-border-hover)]"
                style={{ borderColor: "var(--app-home-border)" }}
                data-testid="mcp-add-card"
              >
                <span className="flex items-center gap-1.5 text-[13px] font-medium" style={{ color: "var(--app-text-secondary)" }}>
                  <Plus size={14} />
                  {t("mcpAddServer")}
                </span>
                <span className="text-[12px]" style={{ color: "var(--app-text-tertiary)" }}>
                  {layerCount === 0 ? t("mcpNoServers") : t("mcpAddCardHint")}
                </span>
              </button>
            )}
            {visible.length === 0 && filter === "profile" && (
              <p className="col-span-full py-6 text-[13px]" style={{ color: "var(--app-text-tertiary)" }}>
                {t("mcpEmptyFiltered")}
              </p>
            )}
          </div>
        )}
      </div>

      <Dialog open={editing} onOpenChange={(open) => (open ? setEditing(true) : resetForm())}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-base">{editingName ? t("mcpEditServer") : t("mcpAddServer")}</DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">{layerHint}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("mcpServerName")}>
                {(id) => (
                  <Input
                    id={id}
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder={t("mcpServerNamePlaceholder")}
                    className="h-8 text-sm"
                  />
                )}
              </Field>
              <Field label={t("mcpCommand")}>
                {(id) => (
                  <Input
                    id={id}
                    value={form.command}
                    onChange={(e) => setForm({ ...form, command: e.target.value })}
                    placeholder={t("mcpCommandPlaceholder")}
                    className="h-8 font-mono text-sm"
                  />
                )}
              </Field>
            </div>
            <Field label={t("mcpArgs")}>
              {(id) => (
                <Input
                  id={id}
                  value={form.args}
                  onChange={(e) => setForm({ ...form, args: e.target.value })}
                  placeholder={t("mcpArgsPlaceholder")}
                  className="h-8 font-mono text-sm"
                />
              )}
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("mcpDescriptionZh")}>
                {(id) => (
                  <Input
                    id={id}
                    value={form.descriptionZh}
                    onChange={(e) => setForm({ ...form, descriptionZh: e.target.value })}
                    placeholder={t("mcpDescriptionPlaceholder")}
                    className="h-8 text-sm"
                  />
                )}
              </Field>
              <Field label={t("mcpDescriptionEn")}>
                {(id) => (
                  <Input
                    id={id}
                    value={form.descriptionEn}
                    onChange={(e) => setForm({ ...form, descriptionEn: e.target.value })}
                    placeholder={t("mcpDescriptionPlaceholder")}
                    className="h-8 text-sm"
                  />
                )}
              </Field>
            </div>
            <Field label={t("mcpEnv")}>
              {(id) => (
                <textarea
                  id={id}
                  value={form.env}
                  onChange={(e) => setForm({ ...form, env: e.target.value })}
                  placeholder={t("mcpEnvPlaceholder")}
                  className="h-20 w-full resize-none rounded-md border border-input bg-background px-3 py-2 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                />
              )}
            </Field>
          </div>

          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={resetForm}>
              {tCommon("cancel")}
            </Button>
            <Button size="sm" onClick={handleSave}>
              {tCommon("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  return (
    <FormField label={label} className="space-y-1" labelClassName="text-xs">
      {({ id }) => children(id)}
    </FormField>
  );
}

function FilterChip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className="rounded-full px-3 py-1 text-xs transition-colors"
      style={
        active
          ? { background: "color-mix(in srgb, var(--app-accent) 16%, transparent)", color: "var(--app-accent)" }
          : { background: "color-mix(in srgb, var(--app-text-primary) 5%, transparent)", color: "var(--app-text-secondary)" }
      }
    >
      {label}
    </button>
  );
}

function McpCard({
  entry,
  source,
  description,
  busy,
  onToggle,
  onRun,
  onEdit,
  onDelete,
}: {
  entry: McpHubEntry;
  source: string;
  description: string | null;
  busy: boolean;
  onToggle: () => void;
  onRun: (running: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("settings");
  const tone = toneFor(entry.name);
  const command =
    entry.kind === "ccpanes" ? null : entry.kind === "shared" ? commandLine(entry.server.config) : commandLine(entry.config);
  const status = entry.kind === "shared" ? sharedStatusKey(entry.server.status) : null;
  const failure = entry.kind === "shared" ? sharedMcpFailureMessage(entry.server.status) : null;
  const running = status === "running";
  const envKeys = entry.kind === "layer" ? Object.keys(entry.config.env) : [];
  const dimmed = entry.kind !== "layer" && !entry.enabled;

  return (
    <div
      className="flex min-h-[132px] flex-col gap-2.5 rounded-xl border p-3.5 transition-colors"
      style={{
        background: "var(--app-home-surface)",
        borderColor: "var(--app-home-border)",
        opacity: dimmed ? 0.7 : 1,
      }}
      data-testid="mcp-card"
      data-mcp-name={entry.name}
    >
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold"
          style={{
            background: `color-mix(in srgb, var(--app-tag-${tone}) 18%, transparent)`,
            color: `var(--app-tag-${tone})`,
          }}
        >
          {iconGlyph(entry.name.replace(/^CC-Panes\s*/, ""))}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium" style={{ color: "var(--app-text-primary)" }} title={entry.name}>
            {entry.name}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
            <span>{source}</span>
            {status && (
              <>
                <span aria-hidden="true">·</span>
                <span style={{ color: running ? "var(--app-status-success)" : status === "failed" ? "var(--app-status-danger)" : undefined }}>
                  {t(`mcpStatus.${status}`)}
                </span>
              </>
            )}
          </div>
        </div>
        {entry.kind !== "layer" && (
          <Switch
            checked={entry.enabled}
            disabled={!entry.canToggle}
            onCheckedChange={onToggle}
            aria-label={entry.name}
          />
        )}
      </div>

      <p
        className="line-clamp-2 flex-1 text-xs leading-relaxed"
        style={{ color: description ? "var(--app-text-secondary)" : "var(--app-text-tertiary)" }}
        title={description ?? undefined}
      >
        {description ?? (entry.kind === "layer" ? t("mcpNoDescription") : "")}
      </p>
      {failure && (
        <p
          className="line-clamp-2 break-all font-mono text-[11px] leading-relaxed"
          style={{ color: "var(--app-status-danger)" }}
          title={failure}
          data-testid="mcp-card-failure"
        >
          {failure}
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {command && (
            <span className="truncate font-mono text-[11px]" style={{ color: "var(--app-text-tertiary)" }} title={command}>
              {command}
            </span>
          )}
          {envKeys.map((key) => (
            <Badge key={key} variant="outline" className="shrink-0 text-[10px]">{key}</Badge>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {entry.kind === "shared" && entry.enabled && !running && status !== "starting" && (
            <span className="mr-1 text-[10px]" style={{ color: "var(--app-status-warning, var(--app-text-tertiary))" }}>
              {t("mcpEnabledNotRunning")}
            </span>
          )}
          {entry.kind === "shared" && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              disabled={busy || status === "starting"}
              onClick={() => onRun(running)}
              aria-label={running ? t("mcpStop") : t("mcpStart")}
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : running ? <Square size={13} /> : <Play size={13} />}
              <span className="ml-1">{running ? t("mcpStop") : t("mcpStart")}</span>
            </Button>
          )}
          {entry.kind === "layer" && (
            <>
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onEdit} aria-label={t("mcpEdit")} title={t("mcpEdit")}>
                <Pencil size={13} />
              </Button>
              <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={onDelete} aria-label={t("mcpDelete")} title={t("mcpDelete")}>
                <Trash2 size={13} />
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
