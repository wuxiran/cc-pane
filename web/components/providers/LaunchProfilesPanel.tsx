import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { toast } from "sonner";
import { Cable, KeyRound, Layers3, Link2, Pencil, Plus, Save, Settings2, Sparkles, Star, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useLaunchProfilesStore, usePanesStore, useProvidersStore, useSharedMcpStore, useWorkspacesStore } from "@/stores";
import type { DiscoveredExternalSkill, InstalledUserSkill, KimiConfigMode, LaunchProfile, LaunchProfileDraft, LaunchProfileResolution, LaunchProfileRuntime, SkillMarketEntry } from "@/types";
import { cn } from "@/lib/utils";
import ProviderToolTabs from "./ProviderToolTabs";
import SharedMcpSection from "@/components/settings/SharedMcpSection";
import { CLI_TOOL_TABS, getCompatibleCliTools } from "@/types/provider";
import type { KnownCliTool } from "@/types/terminal";
import type { Workspace } from "@/types/workspace";
import { skillService } from "@/services/skillService";

const SYSTEM_DEFAULT_PROFILE_ID = "__system_default__";
const WORKSPACE_FILTER_ALL = "__all_workspaces__";

const BUILTIN_SKILLS = [
  "ccpanes-launch-task",
  "ccpanes-dispatch-todos",
  "ccpanes-browse-sessions",
  "ccpanes-memory-dual-write",
];

type ExternalSkillSourceKind = "claude" | "codex" | "plugin";

const EXTERNAL_SKILL_GROUPS: Array<{
  kind: ExternalSkillSourceKind;
  label: string;
  policyKey: "includeExternalClaudeSkills" | "includeExternalCodexSkills" | "includeExternalPluginSkills";
  applicableTools: KnownCliTool[];
}> = [
  { kind: "claude", label: "Claude", policyKey: "includeExternalClaudeSkills", applicableTools: ["claude"] },
  { kind: "codex", label: "Codex", policyKey: "includeExternalCodexSkills", applicableTools: ["codex"] },
  { kind: "plugin", label: "Plugin", policyKey: "includeExternalPluginSkills", applicableTools: ["claude"] },
];

const TOOL_LABELS: Record<KnownCliTool, string> = {
  none: "",
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  kimi: "Kimi",
  glm: "GLM",
  opencode: "OpenCode",
  cursor: "Cursor",
  grok: "Grok",
};

const panelClass = "rounded-lg border border-border bg-[var(--app-content)]";
const inputClass = "h-9 w-full rounded-md border bg-background px-3 text-sm disabled:opacity-70";

function toolLabel(tool: KnownCliTool | string, t: TFunction<["providers", "common"]>): string {
  if (tool === "none") return t("toolNone");
  return TOOL_LABELS[tool as KnownCliTool] || tool;
}

function profileMatchesTool(profile: Pick<LaunchProfile, "targetTools">, tool: KnownCliTool): boolean {
  return profile.targetTools.length === 0 || profile.targetTools.includes(tool);
}

function launchEnvironmentLabel(targetTools: string[], fallbackTool: KnownCliTool, t: TFunction<["providers", "common"]>): string {
  return toolLabel(targetTools[0] ?? fallbackTool, t);
}

function runtimeLabel(runtime: LaunchProfileRuntime, t: TFunction<["providers", "common"]>): string {
  return runtime ? t(`runtime.${runtime}`) : t("runtimeAll");
}

function kimiConfigMode(options?: LaunchProfileDraft["adapterOptions"]): KimiConfigMode {
  return options?.kimiConfigMode === "native" ? "native" : "managed";
}

function isSharedMcpServerSelected(policy: LaunchProfileDraft["mcpPolicy"], name: string): boolean {
  if (!policy.includeSharedMcp || policy.mode === "disabled") return false;
  if (policy.mode === "custom") return policy.enabledServerIds.includes(name);
  return !policy.disabledServerIds.includes(name);
}

function selectedSharedMcpCount(policy: LaunchProfileDraft["mcpPolicy"], names: string[]): number {
  return names.filter((name) => isSharedMcpServerSelected(policy, name)).length;
}

function builtinSkillId(name: string): string {
  return `builtin:${name}`;
}

function isBuiltinSkillSelected(policy: LaunchProfileDraft["skillPolicy"], name: string): boolean {
  const id = builtinSkillId(name);
  if (policy.mode === "disabled") return false;
  if (policy.mode === "custom") return policy.enabledSkillIds.includes(id);
  return !policy.disabledSkillIds.includes(id);
}

function selectedBuiltinSkillCount(policy: LaunchProfileDraft["skillPolicy"]): number {
  return BUILTIN_SKILLS.filter((name) => isBuiltinSkillSelected(policy, name)).length;
}

function profileSkillId(id: string): string {
  return `profile:${id}`;
}

function isProfileSkillSelected(policy: LaunchProfileDraft["skillPolicy"], id: string): boolean {
  const skillId = profileSkillId(id);
  if (policy.mode === "disabled") return false;
  if (policy.mode === "custom") return policy.enabledSkillIds.includes(skillId);
  return !policy.disabledSkillIds.includes(skillId);
}

function selectedProfileSkillCount(policy: LaunchProfileDraft["skillPolicy"]): number {
  return policy.profileSkills.filter((skill) => isProfileSkillSelected(policy, skill.id)).length;
}

function userSkillId(id: string): string {
  return `user:${id}`;
}

function isUserSkillSelected(policy: LaunchProfileDraft["skillPolicy"], id: string): boolean {
  if (policy.mode === "disabled") return false;
  return policy.enabledSkillIds.includes(userSkillId(id));
}

function selectedUserSkillCount(policy: LaunchProfileDraft["skillPolicy"], skills: InstalledUserSkill[]): number {
  return skills.filter((skill) => isUserSkillSelected(policy, skill.id)).length;
}

function externalSkillSourceKind(skill: DiscoveredExternalSkill): ExternalSkillSourceKind {
  return skill.source.kind;
}

function isExternalSourceIncluded(
  policy: LaunchProfileDraft["skillPolicy"],
  kind: ExternalSkillSourceKind,
): boolean {
  const group = EXTERNAL_SKILL_GROUPS.find((item) => item.kind === kind);
  return group ? policy[group.policyKey] ?? true : true;
}

function isExternalSkillSelected(policy: LaunchProfileDraft["skillPolicy"], skill: DiscoveredExternalSkill): boolean {
  if (policy.mode === "disabled" || !isExternalSourceIncluded(policy, externalSkillSourceKind(skill))) return false;
  if (policy.mode === "custom") return policy.enabledSkillIds.includes(skill.id);
  return !policy.disabledSkillIds.includes(skill.id);
}

function selectedExternalSkillCount(policy: LaunchProfileDraft["skillPolicy"], skills: DiscoveredExternalSkill[]): number {
  return skills.filter((skill) => isExternalSkillSelected(policy, skill)).length;
}

function installableMarketEntry(entry: SkillMarketEntry): boolean {
  return Boolean(entry.license?.trim() && entry.contentUrl?.trim() && entry.sha256?.trim());
}

function profileDisplayName(profile: Pick<LaunchProfile, "name" | "alias">): string {
  return profile.alias?.trim() || profile.name;
}

function draftDisplayName(draft: Pick<LaunchProfileDraft, "name" | "alias">, t: TFunction<["providers", "common"]>): string {
  return draft.alias?.trim() || draft.name?.trim() || t("profileFallbackName");
}

function workspaceProfileIds(workspace: Workspace | null): Set<string> {
  const ids = new Set<string>();
  if (!workspace) return ids;
  if (workspace.launchProfileId) ids.add(workspace.launchProfileId);
  for (const project of workspace.projects) {
    if (project.launchProfileId) ids.add(project.launchProfileId);
  }
  return ids;
}

function systemDefaultLaunchProfileDraft(tool: KnownCliTool, runtime: LaunchProfileRuntime = null, t: TFunction<["providers", "common"]>): LaunchProfileDraft {
  return {
    name: t("systemDefaultName", { tool: toolLabel(tool, t) }),
    alias: t("systemDefaultName", { tool: toolLabel(tool, t) }),
    description: t("systemDefaultDescription"),
    providerId: null,
    adapterOptions: {},
    targetTools: [tool],
    targetRuntime: runtime,
    yoloMode: false,
    mcpPolicy: {
      mode: "default",
      enabledServerIds: [],
      disabledServerIds: [],
      includeCcpanesMcp: true,
      includeSharedMcp: true,
    },
    skillPolicy: {
      mode: "core",
      enabledSkillIds: [],
      disabledSkillIds: [],
      profileSkills: [],
      includeProjectSkills: true,
      includeExternalClaudeSkills: true,
      includeExternalCodexSkills: true,
      includeExternalPluginSkills: true,
      target: "session",
    },
    isDefault: false,
  };
}

function toDraft(profile: LaunchProfile): LaunchProfileDraft {
  return {
    name: profile.name,
    alias: profile.alias ?? profile.name,
    description: profile.description ?? "",
    providerId: profile.providerId ?? null,
    adapterOptions: { ...(profile.adapterOptions ?? {}) },
    targetTools: profile.targetTools,
    targetRuntime: profile.targetRuntime ?? null,
    yoloMode: profile.yoloMode ?? false,
    mcpPolicy: profile.mcpPolicy,
    skillPolicy: profile.skillPolicy,
    isDefault: profile.isDefault,
  };
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="space-y-1.5 text-xs">
      <span className="font-medium" style={{ color: "var(--app-text-secondary)" }}>{label}</span>
      {children}
    </label>
  );
}

function Section({
  title,
  description,
  icon,
  children,
}: {
  title: string;
  description: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={cn(panelClass, "p-4")}>
      <div className="mb-4 flex items-start gap-3">
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
          style={{ background: "color-mix(in srgb, var(--app-accent) 12%, transparent)", color: "var(--app-accent)" }}
        >
          {icon}
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold" style={{ color: "var(--app-text-primary)" }}>{title}</h3>
          <p className="mt-0.5 text-xs" style={{ color: "var(--app-text-tertiary)" }}>{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function PreviewItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-border px-3 py-2">
      <div className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>{label}</div>
      <div className="mt-1 truncate text-sm font-medium" style={{ color: "var(--app-text-primary)" }}>{value}</div>
    </div>
  );
}

interface LaunchProfilesPanelProps {
  compact?: boolean;
  initialTool?: KnownCliTool;
  initialRuntime?: LaunchProfileRuntime;
  onActiveToolChange?: (tool: KnownCliTool) => void;
}

export default function LaunchProfilesPanel({
  compact,
  initialTool = "claude",
  initialRuntime = null,
  onActiveToolChange,
}: LaunchProfilesPanelProps) {
  const { t } = useTranslation(["providers", "common"]);
  const profiles = useLaunchProfilesStore((s) => s.profiles);
  const loadProfiles = useLaunchProfilesStore((s) => s.load);
  const createProfile = useLaunchProfilesStore((s) => s.create);
  const updateProfile = useLaunchProfilesStore((s) => s.update);
  const removeProfile = useLaunchProfilesStore((s) => s.remove);
  const setDefaultProfile = useLaunchProfilesStore((s) => s.setDefault);
  const previewProfile = useLaunchProfilesStore((s) => s.preview);
  const providers = useProvidersStore((s) => s.providers);
  const loadProviders = useProvidersStore((s) => s.loadProviders);
  const servers = useSharedMcpStore((s) => s.servers);
  const fetchMcpStatus = useSharedMcpStore((s) => s.fetchStatus);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const workspacesLoading = useWorkspacesStore((s) => s.loading);
  const loadWorkspaces = useWorkspacesStore((s) => s.load);
  const updateWorkspaceLaunchProfile = useWorkspacesStore((s) => s.updateWorkspaceLaunchProfile);
  const openSkillManager = usePanesStore((s) => s.openSkillManager);

  const [activeTool, setActiveTool] = useState<KnownCliTool>(initialTool);
  const [selectedId, setSelectedId] = useState<string | null>(SYSTEM_DEFAULT_PROFILE_ID);
  const [draft, setDraft] = useState<LaunchProfileDraft>(() => systemDefaultLaunchProfileDraft(initialTool, initialRuntime, t));
  const [preview, setPreview] = useState<LaunchProfileResolution | null>(null);
  const [mcpManagerOpen, setMcpManagerOpen] = useState(false);
  const [workspaceBindingOpen, setWorkspaceBindingOpen] = useState(false);
  const [bindingWorkspaceName, setBindingWorkspaceName] = useState<string | null>(null);
  const [workspaceFilterName, setWorkspaceFilterName] = useState(WORKSPACE_FILTER_ALL);
  const [profileSkillEditorOpen, setProfileSkillEditorOpen] = useState(false);
  const [editingProfileSkillId, setEditingProfileSkillId] = useState<string | null>(null);
  const [profileSkillForm, setProfileSkillForm] = useState({ name: "", description: "", content: "" });
  const [marketEntries, setMarketEntries] = useState<SkillMarketEntry[]>([]);
  const [userSkills, setUserSkills] = useState<InstalledUserSkill[]>([]);
  const [externalSkills, setExternalSkills] = useState<DiscoveredExternalSkill[]>([]);
  const [skillMarketLoading, setSkillMarketLoading] = useState(false);
  const [installingSkillId, setInstallingSkillId] = useState<string | null>(null);
  // YOLO（权限绕过）是危险操作：开启需二次确认，避免误触。
  const [yoloConfirmOpen, setYoloConfirmOpen] = useState(false);
  const workspaceContext = useMemo(
    () => workspaceFilterName === WORKSPACE_FILTER_ALL
      ? null
      : workspaces.find((workspace) => workspace.name === workspaceFilterName) ?? null,
    [workspaceFilterName, workspaces],
  );
  const workspaceBoundProfileIds = useMemo(
    () => workspaceProfileIds(workspaceContext),
    [workspaceContext],
  );
  const toolDefaultProfile = useMemo(
    () => profiles.find((profile) => profile.isDefault && profileMatchesTool(profile, activeTool)) ?? null,
    [activeTool, profiles],
  );
  const selectedProfileId = selectedId === SYSTEM_DEFAULT_PROFILE_ID
    ? toolDefaultProfile?.id ?? null
    : selectedId;
  const boundWorkspaces = useMemo(
    () => selectedProfileId
      ? workspaces.filter((workspace) => workspace.launchProfileId === selectedProfileId)
      : [],
    [selectedProfileId, workspaces],
  );

  useEffect(() => {
    loadProfiles();
    loadProviders();
    loadWorkspaces();
    fetchMcpStatus();
  }, [fetchMcpStatus, loadProfiles, loadProviders, loadWorkspaces]);

  useEffect(() => {
    if (
      workspaceFilterName !== WORKSPACE_FILTER_ALL
      && !workspaces.some((workspace) => workspace.name === workspaceFilterName)
    ) {
      setWorkspaceFilterName(WORKSPACE_FILTER_ALL);
    }
  }, [workspaceFilterName, workspaces]);

  useEffect(() => {
    if (!selectedId || selectedId === SYSTEM_DEFAULT_PROFILE_ID) return;
    const profile = profiles.find((item) => item.id === selectedId);
    if (!profile || !profileMatchesTool(profile, activeTool)) {
      setSelectedId(SYSTEM_DEFAULT_PROFILE_ID);
      setDraft((current) => toolDefaultProfile ? toDraft(toolDefaultProfile) : systemDefaultLaunchProfileDraft(activeTool, current.targetRuntime ?? null, t));
    }
  }, [activeTool, profiles, selectedId, toolDefaultProfile]);

  useEffect(() => {
    if (selectedId === SYSTEM_DEFAULT_PROFILE_ID) {
      setDraft((current) => toolDefaultProfile ? toDraft(toolDefaultProfile) : systemDefaultLaunchProfileDraft(activeTool, current.targetRuntime ?? null, t));
    }
  }, [activeTool, selectedId, toolDefaultProfile]);

  useEffect(() => {
    if (selectedId === null || selectedId === SYSTEM_DEFAULT_PROFILE_ID) return;
    const profile = profiles.find((item) => item.id === selectedId);
    if (profile) setDraft(toDraft(profile));
  }, [profiles, selectedId]);

  useEffect(() => {
    let cancelled = false;

    if (selectedId === null) {
      setPreview(null);
      return () => {
        cancelled = true;
      };
    }

    const request = selectedId === SYSTEM_DEFAULT_PROFILE_ID
      ? toolDefaultProfile
        ? {
            profileId: toolDefaultProfile.id,
            workspaceName: workspaceContext?.name ?? null,
            cliTool: activeTool,
            runtimeKind: draft.targetRuntime ?? null,
          }
        : {
          useSystemDefault: true,
          workspaceName: workspaceContext?.name ?? null,
          providerSelection: "none" as const,
          cliTool: activeTool,
          runtimeKind: draft.targetRuntime ?? null,
        }
      : {
          profileId: selectedId,
          workspaceName: workspaceContext?.name ?? null,
          cliTool: activeTool,
          runtimeKind: draft.targetRuntime ?? null,
        };

    previewProfile(request)
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch(() => {
        if (!cancelled) setPreview(null);
      });

    return () => {
      cancelled = true;
    };
  }, [activeTool, draft.targetRuntime, previewProfile, profiles, selectedId, toolDefaultProfile, workspaceContext?.name]);

  const selectedProfile = useMemo(
    () => selectedId === SYSTEM_DEFAULT_PROFILE_ID
      ? toolDefaultProfile
      : profiles.find((profile) => profile.id === selectedId) ?? null,
    [profiles, selectedId, toolDefaultProfile],
  );
  const isSystemDefaultSelected = selectedId === SYSTEM_DEFAULT_PROFILE_ID;
  const isNewProfile = selectedId === null;
  const currentKimiConfigMode = kimiConfigMode(draft.adapterOptions);
  const providerDisabled = isSystemDefaultSelected || activeTool === "kimi";
  const filteredProfiles = useMemo(() => {
    const compatible = profiles.filter((profile) => profileMatchesTool(profile, activeTool));
    if (!workspaceContext) return compatible;
    return compatible.filter(
      (profile) => profile.isDefault || workspaceBoundProfileIds.has(profile.id),
    );
  }, [activeTool, profiles, toolDefaultProfile?.id, workspaceBoundProfileIds, workspaceContext]);
  const profileCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const tab of CLI_TOOL_TABS) {
      counts[tab.id] = profiles.filter((profile) => profileMatchesTool(profile, tab.id)).length;
    }
    return counts;
  }, [profiles]);
  const compatibleProviders = useMemo(
    () => providers.filter((provider) => getCompatibleCliTools(provider.providerType).includes(activeTool)),
    [activeTool, providers],
  );
  const selectedDraftProvider = providers.find((provider) => provider.id === draft.providerId);
  const providerOptions = selectedDraftProvider && !compatibleProviders.some((provider) => provider.id === selectedDraftProvider.id)
    ? [selectedDraftProvider, ...compatibleProviders]
    : compatibleProviders;

  const refreshSkillMarket = useCallback(async () => {
    setSkillMarketLoading(true);
    try {
      const [entries, installed, external] = await Promise.all([
        skillService.listSkillMarketEntries(),
        skillService.listUserSkills(),
        skillService.listExternalSkills(),
      ]);
      setMarketEntries(entries);
      setUserSkills(installed);
      setExternalSkills(external);
    } catch (error) {
      toast.error(t("toast.loadSkillFailed", { error: String(error) }));
    } finally {
      setSkillMarketLoading(false);
    }
  }, [t]);

  useEffect(() => {
    refreshSkillMarket();
  }, [refreshSkillMarket]);

  useEffect(() => {
    if (selectedId === null || selectedId === SYSTEM_DEFAULT_PROFILE_ID) return;
    if (!filteredProfiles.some((profile) => profile.id === selectedId)) {
      setSelectedId(SYSTEM_DEFAULT_PROFILE_ID);
      setDraft((current) => toolDefaultProfile ? toDraft(toolDefaultProfile) : systemDefaultLaunchProfileDraft(activeTool, current.targetRuntime ?? null, t));
    }
  }, [activeTool, filteredProfiles, selectedId, toolDefaultProfile]);

  const resetTransientState = useCallback(() => {
    setPreview(null);
    setMcpManagerOpen(false);
    setWorkspaceBindingOpen(false);
    setBindingWorkspaceName(null);
    setProfileSkillEditorOpen(false);
    setEditingProfileSkillId(null);
    setProfileSkillForm({ name: "", description: "", content: "" });
  }, []);

  const handleToolChange = useCallback((tool: KnownCliTool) => {
    if (tool === activeTool) return;
    setActiveTool(tool);
    onActiveToolChange?.(tool);
    setSelectedId(SYSTEM_DEFAULT_PROFILE_ID);
    setDraft(systemDefaultLaunchProfileDraft(tool, draft.targetRuntime ?? null, t));
    resetTransientState();
  }, [activeTool, draft.targetRuntime, onActiveToolChange, resetTransientState]);

  const handleSelectSystemDefault = useCallback(() => {
    setSelectedId(SYSTEM_DEFAULT_PROFILE_ID);
    setDraft((current) => toolDefaultProfile ? toDraft(toolDefaultProfile) : systemDefaultLaunchProfileDraft(activeTool, current.targetRuntime ?? null, t));
    resetTransientState();
  }, [activeTool, resetTransientState, toolDefaultProfile]);

  const handleSelect = useCallback((profile: LaunchProfile) => {
    setSelectedId(profile.id);
    setDraft(toDraft(profile));
    resetTransientState();
  }, [resetTransientState]);

  const handleCopySystemDefault = useCallback(() => {
    const base = selectedId === SYSTEM_DEFAULT_PROFILE_ID ? draft : systemDefaultLaunchProfileDraft(activeTool, draft.targetRuntime ?? null, t);
    setSelectedId(null);
    setDraft({
      ...base,
      name: t("profileDefaultName", { tool: toolLabel(activeTool, t) }),
      alias: t("profileDefaultName", { tool: toolLabel(activeTool, t) }),
      targetTools: [activeTool],
      targetRuntime: draft.targetRuntime ?? null,
      isDefault: false,
    });
    setPreview(null);
    setMcpManagerOpen(false);
    setWorkspaceBindingOpen(false);
    setBindingWorkspaceName(null);
    toast.success(t("toast.draftCreated", { tool: toolLabel(activeTool, t) }));
  }, [activeTool, draft, selectedId, t]);

  const handleSave = useCallback(async () => {
    try {
      const alias = draft.alias?.trim() || draft.name?.trim() || t("profileDefaultName", { tool: toolLabel(activeTool, t) });
      const nextDraft = {
        ...draft,
        name: draft.name?.trim() || alias,
        alias,
        providerId: isSystemDefaultSelected || activeTool === "kimi" ? null : draft.providerId,
        adapterOptions: activeTool === "kimi"
          ? { ...(draft.adapterOptions ?? {}), kimiConfigMode: currentKimiConfigMode }
          : draft.adapterOptions ?? {},
        isDefault: isSystemDefaultSelected ? true : draft.isDefault,
        targetTools: [activeTool],
        targetRuntime: draft.targetRuntime ?? null,
      };
      const profileToUpdate = isSystemDefaultSelected ? toolDefaultProfile : selectedProfile;
      const saved = profileToUpdate
        ? await updateProfile(profileToUpdate.id, nextDraft)
        : await createProfile(nextDraft);
      if (isSystemDefaultSelected) {
        setSelectedId(SYSTEM_DEFAULT_PROFILE_ID);
        setDraft(toDraft(saved));
        toast.success(t("toast.systemDefaultSaved"));
        return;
      }

      if (!selectedProfile && workspaceContext) {
        await updateWorkspaceLaunchProfile(workspaceContext.name, saved.id);
      }
      setSelectedId(saved.id);
      setDraft(toDraft(saved));
      toast.success(workspaceContext && !selectedProfile
        ? t("toast.profileSavedBound", { name: workspaceContext.name })
        : t("toast.profileSaved"));
    } catch (error) {
      toast.error(t("common:saveFailed", { error: String(error) }));
    }
  }, [activeTool, createProfile, currentKimiConfigMode, draft, isSystemDefaultSelected, selectedProfile, t, toolDefaultProfile, updateProfile, updateWorkspaceLaunchProfile, workspaceContext]);

  const handleDelete = useCallback(async () => {
    if (!selectedProfile || isSystemDefaultSelected) return;
    try {
      for (const workspace of workspaces.filter((item) => item.launchProfileId === selectedProfile.id)) {
        await updateWorkspaceLaunchProfile(workspace.name, null);
      }
      await removeProfile(selectedProfile.id);
      setSelectedId(SYSTEM_DEFAULT_PROFILE_ID);
      setDraft((current) => toolDefaultProfile ? toDraft(toolDefaultProfile) : systemDefaultLaunchProfileDraft(activeTool, current.targetRuntime ?? null, t));
      toast.success(t("toast.profileDeleted"));
    } catch (error) {
      toast.error(t("common:deleteFailed", { error: String(error) }));
    }
  }, [activeTool, isSystemDefaultSelected, removeProfile, selectedProfile, t, toolDefaultProfile, updateWorkspaceLaunchProfile, workspaces]);

  const handleSetDefault = useCallback(async () => {
    if (!selectedProfile) return;
    await setDefaultProfile(selectedProfile.id);
    toast.success(t("toast.defaultProfileUpdated"));
  }, [selectedProfile, setDefaultProfile, t]);

  const handleToggleWorkspaceBinding = useCallback(async (workspaceName: string, checked: boolean) => {
    if (!selectedProfileId) {
      toast.info(t("toast.saveProfileFirst"));
      return;
    }
    setBindingWorkspaceName(workspaceName);
    try {
      await updateWorkspaceLaunchProfile(workspaceName, checked ? selectedProfileId : null);
      toast.success(checked ? t("toast.boundTo", { name: workspaceName }) : t("toast.unboundFrom", { name: workspaceName }));
    } catch (error) {
      toast.error(t("toast.workspaceBindFailed", { error: String(error) }));
    } finally {
      setBindingWorkspaceName(null);
    }
  }, [selectedProfileId, t, updateWorkspaceLaunchProfile]);

  const setMcpMode = (mode: LaunchProfileDraft["mcpPolicy"]["mode"]) => {
    setDraft((current) => {
      const enabledServerIds = new Set(current.mcpPolicy.enabledServerIds);
      if (mode === "custom" && current.mcpPolicy.mode !== "custom" && enabledServerIds.size === 0) {
        const disabledServerIds = new Set(current.mcpPolicy.disabledServerIds);
        for (const server of servers) {
          if (!disabledServerIds.has(server.name)) enabledServerIds.add(server.name);
        }
      }

      return {
        ...current,
        mcpPolicy: {
          ...current.mcpPolicy,
          mode,
          includeCcpanesMcp: mode === "disabled" ? false : current.mcpPolicy.includeCcpanesMcp || current.mcpPolicy.mode === "disabled",
          includeSharedMcp: mode === "disabled" ? false : current.mcpPolicy.includeSharedMcp || current.mcpPolicy.mode === "disabled",
          enabledServerIds: Array.from(enabledServerIds),
        },
      };
    });
  };
  const setSkillMode = (mode: LaunchProfileDraft["skillPolicy"]["mode"]) => {
    setDraft((current) => {
      const enabled = new Set(current.skillPolicy.enabledSkillIds);
      if (mode === "custom" && current.skillPolicy.mode !== "custom") {
        const disabled = new Set(current.skillPolicy.disabledSkillIds);
        const hasBuiltinSelection = BUILTIN_SKILLS.some((name) => enabled.has(builtinSkillId(name)));
        if (!hasBuiltinSelection) {
          for (const name of BUILTIN_SKILLS) {
            if (!disabled.has(builtinSkillId(name))) enabled.add(builtinSkillId(name));
          }
        }
        for (const skill of current.skillPolicy.profileSkills) {
          const id = profileSkillId(skill.id);
          if (!disabled.has(id)) enabled.add(id);
        }
        for (const skill of externalSkills) {
          if (
            isExternalSourceIncluded(current.skillPolicy, externalSkillSourceKind(skill))
            && !disabled.has(skill.id)
          ) {
            enabled.add(skill.id);
          }
        }
      }

      return {
        ...current,
        skillPolicy: {
          ...current.skillPolicy,
          mode,
          enabledSkillIds: Array.from(enabled),
        },
      };
    });
  };
  const setKimiConfigMode = (mode: KimiConfigMode) => {
    setDraft((current) => ({
      ...current,
      providerId: null,
      adapterOptions: {
        ...(current.adapterOptions ?? {}),
        kimiConfigMode: mode,
      },
    }));
  };
  const toggleServer = (name: string) => {
    setDraft((current) => {
      const enabled = new Set(current.mcpPolicy.enabledServerIds);
      const disabled = new Set(current.mcpPolicy.disabledServerIds);
      if (current.mcpPolicy.mode === "default") {
        if (disabled.has(name)) disabled.delete(name);
        else disabled.add(name);
        return {
          ...current,
          mcpPolicy: {
            ...current.mcpPolicy,
            disabledServerIds: Array.from(disabled),
          },
        };
      }

      if (enabled.has(name)) enabled.delete(name);
      else enabled.add(name);
      return {
        ...current,
        mcpPolicy: {
          ...current.mcpPolicy,
          mode: "custom",
          enabledServerIds: Array.from(enabled),
        },
      };
    });
  };
  const toggleSkill = (name: string) => {
    const id = builtinSkillId(name);
    setDraft((current) => {
      const enabled = new Set(current.skillPolicy.enabledSkillIds);
      const disabled = new Set(current.skillPolicy.disabledSkillIds);
      if (current.skillPolicy.mode === "core") {
        if (disabled.has(id)) disabled.delete(id);
        else disabled.add(id);
        return {
          ...current,
          skillPolicy: {
            ...current.skillPolicy,
            disabledSkillIds: Array.from(disabled),
          },
        };
      }

      if (enabled.has(id)) enabled.delete(id);
      else enabled.add(id);
      return {
        ...current,
        skillPolicy: {
          ...current.skillPolicy,
          mode: "custom",
          enabledSkillIds: Array.from(enabled),
          disabledSkillIds: Array.from(disabled).filter((item) => item !== id),
        },
      };
    });
  };
  const toggleProfileSkill = (id: string) => {
    const skillId = profileSkillId(id);
    setDraft((current) => {
      const enabled = new Set(current.skillPolicy.enabledSkillIds);
      const disabled = new Set(current.skillPolicy.disabledSkillIds);
      if (current.skillPolicy.mode === "core") {
        if (disabled.has(skillId)) disabled.delete(skillId);
        else disabled.add(skillId);
        return {
          ...current,
          skillPolicy: {
            ...current.skillPolicy,
            disabledSkillIds: Array.from(disabled),
          },
        };
      }

      if (enabled.has(skillId)) enabled.delete(skillId);
      else enabled.add(skillId);
      return {
        ...current,
        skillPolicy: {
          ...current.skillPolicy,
          mode: "custom",
          enabledSkillIds: Array.from(enabled),
          disabledSkillIds: Array.from(disabled).filter((item) => item !== skillId),
        },
      };
    });
  };
  const enabledSkillIdsForCustomMode = (policy: LaunchProfileDraft["skillPolicy"]) => {
    const enabled = new Set(policy.enabledSkillIds);
    if (policy.mode !== "custom") {
      const disabled = new Set(policy.disabledSkillIds);
      for (const name of BUILTIN_SKILLS) {
        const id = builtinSkillId(name);
        if (!disabled.has(id)) enabled.add(id);
      }
      for (const skill of policy.profileSkills) {
        const id = profileSkillId(skill.id);
        if (!disabled.has(id)) enabled.add(id);
      }
      for (const skill of externalSkills) {
        if (
          isExternalSourceIncluded(policy, externalSkillSourceKind(skill))
          && !disabled.has(skill.id)
        ) {
          enabled.add(skill.id);
        }
      }
    }
    return enabled;
  };
  const toggleExternalSource = (kind: ExternalSkillSourceKind, included: boolean) => {
    const group = EXTERNAL_SKILL_GROUPS.find((item) => item.kind === kind);
    if (!group) return;
    setDraft((current) => ({
      ...current,
      skillPolicy: {
        ...current.skillPolicy,
        [group.policyKey]: included,
      },
    }));
  };
  const toggleExternalSkill = (skill: DiscoveredExternalSkill) => {
    setDraft((current) => {
      const disabled = new Set(current.skillPolicy.disabledSkillIds);
      if (current.skillPolicy.mode === "core") {
        if (disabled.has(skill.id)) disabled.delete(skill.id);
        else disabled.add(skill.id);
        return {
          ...current,
          skillPolicy: {
            ...current.skillPolicy,
            disabledSkillIds: Array.from(disabled),
          },
        };
      }

      const customEnabled = enabledSkillIdsForCustomMode(current.skillPolicy);
      if (customEnabled.has(skill.id)) customEnabled.delete(skill.id);
      else customEnabled.add(skill.id);
      return {
        ...current,
        skillPolicy: {
          ...current.skillPolicy,
          mode: "custom",
          enabledSkillIds: Array.from(customEnabled),
          disabledSkillIds: Array.from(disabled).filter((item) => item !== skill.id),
        },
      };
    });
  };
  const toggleUserSkill = (id: string) => {
    const skillId = userSkillId(id);
    setDraft((current) => {
      const enabled = enabledSkillIdsForCustomMode(current.skillPolicy);
      if (enabled.has(skillId)) enabled.delete(skillId);
      else enabled.add(skillId);
      return {
        ...current,
        skillPolicy: {
          ...current.skillPolicy,
          mode: "custom",
          enabledSkillIds: Array.from(enabled),
          disabledSkillIds: current.skillPolicy.disabledSkillIds.filter((item) => item !== skillId),
        },
      };
    });
  };
  const installAndEnableSkill = async (entry: SkillMarketEntry) => {
    setInstallingSkillId(entry.id);
    try {
      const installed = await skillService.installMarketSkill(entry.id);
      setUserSkills((current) => {
        const next = current.filter((skill) => skill.id !== installed.id);
        next.push(installed);
        return next.sort((left, right) => left.name.localeCompare(right.name));
      });
      const skillId = userSkillId(installed.id);
      setDraft((current) => {
        const enabled = enabledSkillIdsForCustomMode(current.skillPolicy);
        enabled.add(skillId);
        return {
          ...current,
          skillPolicy: {
            ...current.skillPolicy,
            mode: "custom",
            enabledSkillIds: Array.from(enabled),
            disabledSkillIds: current.skillPolicy.disabledSkillIds.filter((item) => item !== skillId),
          },
        };
      });
      toast.success(t("toast.installedAndEnabled", { name: installed.name }));
    } catch (error) {
      toast.error(t("toast.installSkillFailed", { error: String(error) }));
    } finally {
      setInstallingSkillId(null);
    }
  };
  const selectAllBuiltinSkills = () => {
    setDraft((current) => {
      const builtinIds = BUILTIN_SKILLS.map(builtinSkillId);
      const enabled = new Set(current.skillPolicy.enabledSkillIds);
      for (const id of builtinIds) enabled.add(id);
      const disabled = current.skillPolicy.disabledSkillIds.filter((id) => !builtinIds.includes(id));
      return {
        ...current,
        skillPolicy: {
          ...current.skillPolicy,
          mode: current.skillPolicy.mode === "core" ? "core" : "custom",
          enabledSkillIds: Array.from(enabled),
          disabledSkillIds: disabled,
        },
      };
    });
  };
  const clearBuiltinSkills = () => {
    setDraft((current) => {
      const disabled = new Set(current.skillPolicy.disabledSkillIds.filter((id) => !id.startsWith("builtin:")));
      for (const id of BUILTIN_SKILLS.map(builtinSkillId)) disabled.add(id);
      return {
        ...current,
        skillPolicy: {
          ...current.skillPolicy,
          mode: "custom",
          enabledSkillIds: current.skillPolicy.enabledSkillIds.filter((id) => !id.startsWith("builtin:")),
          disabledSkillIds: Array.from(disabled),
        },
      };
    });
  };
  const beginNewProfileSkill = () => {
    setProfileSkillEditorOpen(true);
    setEditingProfileSkillId(null);
    setProfileSkillForm({ name: "", description: "", content: "" });
  };
  const beginEditProfileSkill = (id: string) => {
    const skill = draft.skillPolicy.profileSkills.find((item) => item.id === id);
    if (!skill) return;
    setProfileSkillEditorOpen(true);
    setEditingProfileSkillId(id);
    setProfileSkillForm({
      name: skill.name,
      description: skill.description ?? "",
      content: skill.content,
    });
  };
  const cancelProfileSkillEdit = () => {
    setProfileSkillEditorOpen(false);
    setEditingProfileSkillId(null);
    setProfileSkillForm({ name: "", description: "", content: "" });
  };
  const saveProfileSkill = () => {
    const name = profileSkillForm.name.trim();
    const content = profileSkillForm.content.trim();
    if (!name || !content) {
      toast.error(t("toast.profileSkillRequired"));
      return;
    }

    const id = editingProfileSkillId ?? crypto.randomUUID();
    const skillId = profileSkillId(id);
    setDraft((current) => {
      const existingIndex = current.skillPolicy.profileSkills.findIndex((skill) => skill.id === id);
      const nextSkill = {
        id,
        name,
        description: profileSkillForm.description.trim() || null,
        content,
      };
      const profileSkills = [...current.skillPolicy.profileSkills];
      if (existingIndex >= 0) profileSkills[existingIndex] = nextSkill;
      else profileSkills.push(nextSkill);

      const enabled = new Set(current.skillPolicy.enabledSkillIds);
      const disabled = new Set(current.skillPolicy.disabledSkillIds);
      if (current.skillPolicy.mode === "custom") enabled.add(skillId);
      else disabled.delete(skillId);

      return {
        ...current,
        skillPolicy: {
          ...current.skillPolicy,
          profileSkills,
          enabledSkillIds: Array.from(enabled),
          disabledSkillIds: Array.from(disabled),
        },
      };
    });
    cancelProfileSkillEdit();
  };
  const deleteProfileSkill = (id: string) => {
    const skillId = profileSkillId(id);
    setDraft((current) => ({
      ...current,
      skillPolicy: {
        ...current.skillPolicy,
        profileSkills: current.skillPolicy.profileSkills.filter((skill) => skill.id !== id),
        enabledSkillIds: current.skillPolicy.enabledSkillIds.filter((item) => item !== skillId),
        disabledSkillIds: current.skillPolicy.disabledSkillIds.filter((item) => item !== skillId),
      },
    }));
    if (editingProfileSkillId === id) cancelProfileSkillEdit();
  };
  const openProjectSkillManager = (projectPath: string, title: string) => {
    openSkillManager(projectPath, title);
  };

  const previewProviderLabel = isSystemDefaultSelected
    ? t("previewSystemProvider")
    : preview?.providerName ?? t("noProviderSpecified");
  const previewMcpCount = preview?.mcpServers.filter((server) => server.enabled).length ?? 0;
  const previewSkillCount = preview?.skills.filter((skill) => skill.enabled).length ?? 0;
  const mcpDisabled = draft.mcpPolicy.mode === "disabled";
  const sharedMcpNames = servers.map((server) => server.name);
  const sharedMcpSelectedCount = selectedSharedMcpCount(draft.mcpPolicy, sharedMcpNames);
  const builtinSkillSelectedCount = selectedBuiltinSkillCount(draft.skillPolicy);
  const profileSkillSelectedCount = selectedProfileSkillCount(draft.skillPolicy);
  const installedUserSkillIds = new Set(userSkills.map((skill) => skill.id));
  const marketEntryIds = new Set(marketEntries.map((entry) => entry.id));
  const standaloneUserSkills = userSkills.filter((skill) => !marketEntryIds.has(skill.id));
  const userSkillSelectedCount = selectedUserSkillCount(draft.skillPolicy, userSkills);
  const visibleExternalSkillGroups = EXTERNAL_SKILL_GROUPS.filter((group) =>
    group.applicableTools.includes(activeTool),
  );
  const visibleExternalSkillKinds = new Set(visibleExternalSkillGroups.map((group) => group.kind));
  const visibleExternalSkills = externalSkills.filter((skill) =>
    visibleExternalSkillKinds.has(externalSkillSourceKind(skill)),
  );
  const externalSkillSelectedCount = selectedExternalSkillCount(draft.skillPolicy, visibleExternalSkills);
  const externalSkillGroups = visibleExternalSkillGroups.map((group) => ({
    ...group,
    skills: externalSkills.filter((skill) => externalSkillSourceKind(skill) === group.kind),
  }));
  const currentTitle = isSystemDefaultSelected ? t("systemDefaultName", { tool: toolLabel(activeTool, t) }) : isNewProfile ? draftDisplayName(draft, t) : draftDisplayName(draft, t);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div
        className="shrink-0 border-b border-border px-4 py-3"
        style={{ background: "color-mix(in srgb, var(--app-content) 72%, transparent)" }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Layers3 size={16} style={{ color: "var(--app-accent)" }} />
              <span>{t("panelTitle")}</span>
            </div>
            <div className="mt-1 text-xs" style={{ color: "var(--app-text-tertiary)" }}>
              {t("panelSubtitle")}
            </div>
          </div>
          <div className="max-w-full overflow-x-auto">
            <ProviderToolTabs
              activeTab={activeTool}
              onTabChange={handleToolChange}
              providerCounts={profileCounts}
              compact={false}
            />
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside
          className={cn("shrink-0 overflow-y-auto border-r border-border", compact ? "w-64" : "w-80")}
          style={{ background: "color-mix(in srgb, var(--app-content) 72%, transparent)" }}
        >
        <div className="border-b border-border px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
              <span className="truncate">{t("profileListTitle", { tool: toolLabel(activeTool, t) })}</span>
            </div>
            <Button size="xs" variant="outline" onClick={handleCopySystemDefault}>
              <Plus size={12} /> {t("add")}
            </Button>
          </div>
          <div className="mt-1 text-xs" style={{ color: "var(--app-text-tertiary)" }}>
            {workspaceContext ? t("listScopeWorkspace", { name: workspaceContext.name }) : t("listScopeAll")}
          </div>
          <select
            className="mt-3 h-8 w-full rounded-md border bg-background px-2 text-xs"
            value={workspaceFilterName}
            onChange={(event) => setWorkspaceFilterName(event.target.value)}
          >
            <option value={WORKSPACE_FILTER_ALL}>{t("allWorkspaces")}</option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.name}>
                {workspace.alias || workspace.name}
              </option>
            ))}
          </select>
        </div>

        <div className="p-2">
          <button
            className={cn(
              "w-full rounded-lg border px-3 py-3 text-left transition-colors hover:bg-[var(--app-hover)]",
              isSystemDefaultSelected && "shadow-sm",
            )}
            style={{
              borderColor: isSystemDefaultSelected ? "var(--app-accent)" : "var(--app-border)",
              background: isSystemDefaultSelected ? "color-mix(in srgb, var(--app-accent) 10%, transparent)" : "transparent",
            }}
            onClick={handleSelectSystemDefault}
          >
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                {t("systemDefaultName", { tool: toolLabel(activeTool, t) })}
              </span>
              <Badge variant="secondary" className="text-[10px]">{t("common:default")}</Badge>
            </div>
            <div className="mt-1 text-xs leading-5" style={{ color: "var(--app-text-secondary)" }}>
              {t("systemDefaultCardHint")}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <span className="rounded-md border border-border px-1.5 py-0.5 text-[10px]">CC-Panes MCP</span>
              <span className="rounded-md border border-border px-1.5 py-0.5 text-[10px]">{t("coreSkillTag")}</span>
            </div>
          </button>

          <div className="my-3 h-px bg-border" />

          <div className="space-y-2">
            {filteredProfiles.map((profile) => (
              <button
                key={profile.id}
                className="w-full rounded-lg border px-3 py-3 text-left transition-colors hover:bg-[var(--app-hover)]"
                style={{
                  borderColor: selectedId === profile.id ? "var(--app-accent)" : "var(--app-border)",
                  background: selectedId === profile.id ? "color-mix(in srgb, var(--app-accent) 8%, transparent)" : "transparent",
                }}
                onClick={() => handleSelect(profile)}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{profileDisplayName(profile)}</span>
                  {profile.isDefault && <Badge variant="secondary" className="text-[10px]">{t("common:default")}</Badge>}
                  {workspaceContext && workspaceBoundProfileIds.has(profile.id) && (
                    <Badge variant="outline" className="text-[10px]">{t("workspaceBadge")}</Badge>
                  )}
                </div>
                <div className="mt-1 truncate text-xs" style={{ color: "var(--app-text-secondary)" }}>
                  {providers.find((p) => p.id === profile.providerId)?.name ?? t("noProviderSpecified")}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>
                  <span>{launchEnvironmentLabel(profile.targetTools, activeTool, t)}</span>
                  <span className="rounded-md border border-border px-1.5 py-0.5">
                    {runtimeLabel(profile.targetRuntime ?? null, t)}
                  </span>
                </div>
              </button>
            ))}
          </div>

          {filteredProfiles.length === 0 && (
            <div className="px-2 py-4 text-xs leading-5" style={{ color: "var(--app-text-tertiary)" }}>
              {workspaceContext
                ? t("listEmptyWorkspace")
                : t("listEmptyAll")}
            </div>
          )}
        </div>
        </aside>

        <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-4 px-5 py-5">
          <section className={cn(panelClass, "p-4")}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-base font-semibold" style={{ color: "var(--app-text-primary)" }}>
                    {currentTitle}
                  </h2>
                  {(isSystemDefaultSelected || selectedProfile?.isDefault) && <Badge variant="secondary" className="text-[10px]">{t("common:default")}</Badge>}
                  {!isSystemDefaultSelected && (
                    <Badge variant="outline" className="text-[10px]">{toolLabel(activeTool, t)}</Badge>
                  )}
                  <Badge variant="outline" className="text-[10px]">{runtimeLabel(draft.targetRuntime ?? null, t)}</Badge>
                </div>
                <p className="mt-1 max-w-2xl text-xs leading-5" style={{ color: "var(--app-text-secondary)" }}>
                  {isSystemDefaultSelected
                    ? t("systemDefaultDetail", { tool: toolLabel(activeTool, t) })
                    : t("profileDetail")}
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                {isSystemDefaultSelected ? (
                  <>
                    <Button
                      size="sm"
                      variant={selectedProfileId ? "default" : "outline"}
                      disabled={!selectedProfileId}
                      onClick={() => setWorkspaceBindingOpen((value) => !value)}
                    >
                      <Link2 size={14} /> {selectedProfileId ? t("workspaceBindingCount", { count: boundWorkspaces.length }) : t("bindAfterSave")}
                    </Button>
                    <Button size="sm" variant="outline" onClick={handleCopySystemDefault}>
                      <Plus size={14} /> {t("copyAsProfile")}
                    </Button>
                    <Button size="sm" onClick={handleSave}>
                      <Save size={14} /> {t("saveDefault")}
                    </Button>
                  </>
                ) : (
                  <>
                    {selectedProfile && !selectedProfile.isDefault && (
                      <Button size="sm" variant="outline" onClick={handleSetDefault}>
                        <Star size={14} /> {t("setAsDefault")}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant={selectedProfile ? "default" : "outline"}
                      disabled={!selectedProfile}
                      onClick={() => setWorkspaceBindingOpen((value) => !value)}
                    >
                      <Link2 size={14} /> {selectedProfile ? t("workspaceBindingCount", { count: boundWorkspaces.length }) : t("bindAfterSave")}
                    </Button>
                    {selectedProfile && (
                      <Button size="sm" variant="outline" onClick={handleDelete}>
                        <Trash2 size={14} /> {t("common:delete")}
                      </Button>
                    )}
                    <Button size="sm" onClick={handleSave}>
                      <Save size={14} /> {isNewProfile ? t("saveAsProfile") : t("common:save")}
                    </Button>
                  </>
                )}
              </div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-4">
              <PreviewItem label="Provider" value={previewProviderLabel} />
              <PreviewItem label="MCP" value={t("enabledCount", { count: previewMcpCount })} />
              <PreviewItem label="Skill" value={t("enabledCount", { count: previewSkillCount })} />
              <PreviewItem
                label={t("workspace")}
                value={selectedProfileId ? t("boundCount", { count: boundWorkspaces.length }) : t("notSaved")}
              />
            </div>

            {workspaceBindingOpen && selectedProfileId && (
              <div
                className="mt-4 rounded-lg border p-3 shadow-sm"
                style={{
                  borderColor: "color-mix(in srgb, var(--app-accent) 58%, var(--app-border))",
                  background: "color-mix(in srgb, var(--app-accent) 11%, var(--app-content))",
                }}
              >
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: "var(--app-text-primary)" }}>
                    <span
                      className="flex h-7 w-7 items-center justify-center rounded-md"
                      style={{
                        background: "color-mix(in srgb, var(--app-accent) 22%, transparent)",
                        color: "var(--app-accent)",
                      }}
                    >
                      <Link2 size={14} />
                    </span>
                    {t("workspaceBinding")}
                  </div>
                  <Badge variant="default" className="text-[10px]">
                    {boundWorkspaces.length}
                  </Badge>
                </div>
                {workspacesLoading && workspaces.length === 0 ? (
                  <div className="text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                    {t("loadingWorkspaces")}
                  </div>
                ) : workspaces.length === 0 ? (
                  <div className="text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                    {t("noWorkspaces")}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                    {workspaces.map((workspace) => {
                      const checked = workspace.launchProfileId === selectedProfileId;
                      const currentProfile = workspace.launchProfileId
                        ? profiles.find((profile) => profile.id === workspace.launchProfileId)
                        : null;
                      const currentLabel = currentProfile
                        ? profileDisplayName(currentProfile)
                        : workspace.launchProfileId ? workspace.launchProfileId : t("notBound");
                      return (
                        <label
                          key={workspace.id}
                          className={cn(
                            "flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                            checked && "shadow-sm",
                          )}
                          style={{
                            borderColor: checked
                              ? "color-mix(in srgb, var(--app-accent) 72%, var(--app-border))"
                              : "var(--app-border)",
                            background: checked
                              ? "color-mix(in srgb, var(--app-accent) 18%, var(--app-content))"
                              : "var(--app-content)",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={bindingWorkspaceName === workspace.name}
                            onChange={(event) => handleToggleWorkspaceBinding(workspace.name, event.target.checked)}
                          />
                          <span className="min-w-0 flex-1 truncate">{workspace.alias || workspace.name}</span>
                          <span className="truncate text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>
                            {checked ? t("currentProfile") : currentLabel}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </section>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
            <Section
              title={t("sectionBasicTitle")}
              description={t("sectionBasicDesc")}
              icon={<KeyRound size={16} />}
            >
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Field label={t("fieldAlias")}>
                  <input
                    className={inputClass}
                    value={draft.alias ?? draft.name ?? ""}
                    onChange={(event) => setDraft({ ...draft, alias: event.target.value, name: event.target.value })}
                  />
                </Field>
                <Field label="Provider">
                  <select
                    className={inputClass}
                    disabled={providerDisabled}
                    value={draft.providerId ?? ""}
                    onChange={(event) => setDraft({ ...draft, providerId: event.target.value || null })}
                  >
                    <option value="">{t("noProviderSpecified")}</option>
                    {providerOptions.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                  </select>
                </Field>
              </div>
              {activeTool === "kimi" && (
                <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                  <Field label={t("fieldKimiConfigSource")}>
                    <select
                      className={inputClass}
                      value={currentKimiConfigMode}
                      onChange={(event) => setKimiConfigMode(event.target.value as KimiConfigMode)}
                    >
                      <option value="managed">{t("kimiConfig.managed")}</option>
                      <option value="native">{t("kimiConfig.native")}</option>
                    </select>
                  </Field>
                  <div className="rounded-md border border-[var(--app-status-warning-border)] px-3 py-2 text-xs leading-5 text-[var(--app-status-warning)]">
                    {currentKimiConfigMode === "native"
                      ? t("kimiNativeHint")
                      : t("kimiManagedHint")}
                  </div>
                </div>
              )}
              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                <Field label={t("fieldApplicableCli")}>
                  <div className={cn(inputClass, "flex items-center")}>
                    {toolLabel(activeTool, t)}
                  </div>
                </Field>
                <Field label={t("fieldRuntime")}>
                  <select
                    className={inputClass}
                    value={draft.targetRuntime ?? ""}
                    onChange={(event) => setDraft({
                      ...draft,
                      targetRuntime: event.target.value ? event.target.value as Exclude<LaunchProfileRuntime, null> : null,
                    })}
                  >
                    <option value="">{t("runtimeAll")}</option>
                    <option value="local">{t("runtime.local")}</option>
                    <option value="wsl">{t("runtime.wsl")}</option>
                    <option value="ssh">{t("runtime.ssh")}</option>
                  </select>
                </Field>
              </div>
              <div className="mt-1 text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
                {t("runtimeHint")}
              </div>
              <div className="mt-3">
                <Field label={t("fieldDescription")}>
                  <input
                    className={inputClass}
                    value={draft.description ?? ""}
                    onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                  />
                </Field>
              </div>
            </Section>

            <Section
              title={t("sectionPermTitle")}
              description={t("sectionPermDesc")}
              icon={<Sparkles size={16} />}
            >
              <label
                className={cn(
                  "flex items-start gap-3 rounded-md border px-3 py-2 text-sm transition-colors",
                  draft.yoloMode ? "border-destructive/60 bg-destructive/10" : "border-border",
                )}
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={draft.yoloMode ?? false}
                  onChange={(event) => {
                    if (event.target.checked) {
                      // 开启 = 危险操作：先弹二次确认，确认前不写入 draft
                      setYoloConfirmOpen(true);
                    } else {
                      setYoloConfirmOpen(false);
                      setDraft({ ...draft, yoloMode: false });
                    }
                  }}
                />
                <span className="min-w-0">
                  <span className="block font-medium">
                    YOLO mode
                    {draft.yoloMode ? (
                      <span className="ml-2 align-middle text-[11px] font-semibold text-destructive">
                        {t("yoloBypassed")}
                      </span>
                    ) : null}
                  </span>
                  <span className="block text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                    {t("yoloDesc")}
                  </span>
                </span>
              </label>

              {yoloConfirmOpen && !draft.yoloMode ? (
                <div className="mt-2 rounded-md border border-destructive/60 bg-destructive/10 px-3 py-2 text-xs leading-5">
                  <p className="font-medium text-destructive">{t("yoloConfirmTitle")}</p>
                  <p className="mt-1" style={{ color: "var(--app-text-tertiary)" }}>
                    {t("yoloConfirmBody")}
                  </p>
                  <div className="mt-2 flex gap-2">
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => {
                        setDraft({ ...draft, yoloMode: true });
                        setYoloConfirmOpen(false);
                      }}
                    >
                      {t("yoloConfirmBtn")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setYoloConfirmOpen(false)}
                    >
                      {t("common:cancel")}
                    </Button>
                  </div>
                </div>
              ) : null}

              <div className="mt-3 text-[11px] leading-5" style={{ color: "var(--app-text-tertiary)" }}>
                {t("yoloFootnote")}
              </div>
            </Section>

            <Section
              title={t("sectionPreviewTitle")}
              description={t("sectionPreviewDesc")}
              icon={<Layers3 size={16} />}
            >
              {isNewProfile ? (
                <div className="text-xs leading-5" style={{ color: "var(--app-text-tertiary)" }}>
                  {t("previewAfterSave")}
                </div>
              ) : (
                <div className="space-y-3 text-xs">
                  {workspaceContext && (
                    <div style={{ color: "var(--app-text-secondary)" }}>
                      {t("previewCurrentWorkspace")}<span className="font-medium">{workspaceContext.name}</span>
                    </div>
                  )}
                  {workspaceContext && (
                    <div style={{ color: "var(--app-text-secondary)" }}>
                      {t("previewBoundProfile")}{workspaceContext.launchProfileId ? profileDisplayName(profiles.find((p) => p.id === workspaceContext.launchProfileId) ?? { name: workspaceContext.launchProfileId, alias: null }) : t("notBound")}
                    </div>
                  )}
                  {workspaces.length === 0 && (
                    <div style={{ color: "var(--app-text-tertiary)" }}>{t("previewCreateWorkspaceHint")}</div>
                  )}
                  {!workspaceContext && workspaces.length > 0 && (
                    <div style={{ color: "var(--app-text-tertiary)" }}>{t("previewSelectWorkspaceHint")}</div>
                  )}
                  {preview?.warnings.map((warning) => (
                    <div key={warning} className="rounded-md border border-[var(--app-status-warning-border)] px-3 py-2 text-[var(--app-status-warning)]">
                      {warning}
                    </div>
                  ))}
                </div>
              )}
            </Section>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Section
              title="MCP"
              description={t("sectionMcpDesc")}
              icon={<Cable size={16} />}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-2">
                  {(["default", "custom", "disabled"] as const).map((mode) => (
                    <Button
                      key={mode}
                      size="sm"
                      variant={draft.mcpPolicy.mode === mode ? "default" : "outline"}
                      onClick={() => setMcpMode(mode)}
                    >
                      {t(`mcpMode.${mode}`)}
                    </Button>
                  ))}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setMcpManagerOpen((value) => !value)}
                >
                  <Settings2 size={14} />
                  {mcpManagerOpen ? t("collapseServerLib") : t("manageSharedMcp")}
                </Button>
              </div>

              <div className="mt-4 rounded-md border border-border bg-background px-3 py-2 text-xs" style={{ color: "var(--app-text-secondary)" }}>
                {mcpDisabled
                  ? t("mcpDisabledHint")
                  : draft.mcpPolicy.mode === "custom"
                    ? t("mcpCustomHint")
                    : t("mcpDefaultHint")}
              </div>

              {!mcpDisabled && (
                <div className="mt-4 grid grid-cols-1 gap-2">
                  <label
                    className={cn(
                      "flex items-start gap-3 rounded-md border px-3 py-2 text-sm transition-colors",
                      draft.mcpPolicy.includeCcpanesMcp && "border-primary/50 bg-primary/5",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={draft.mcpPolicy.includeCcpanesMcp}
                      onChange={(event) => setDraft({ ...draft, mcpPolicy: { ...draft.mcpPolicy, includeCcpanesMcp: event.target.checked } })}
                    />
                    <span className="min-w-0">
                      <span className="block font-medium">CC-Panes MCP</span>
                      <span className="block text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("ccpanesMcpDesc")}</span>
                    </span>
                  </label>
                  <label
                    className={cn(
                      "flex items-start gap-3 rounded-md border px-3 py-2 text-sm transition-colors",
                      draft.mcpPolicy.includeSharedMcp && "border-primary/50 bg-primary/5",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={draft.mcpPolicy.includeSharedMcp}
                      onChange={(event) => setDraft({ ...draft, mcpPolicy: { ...draft.mcpPolicy, includeSharedMcp: event.target.checked } })}
                    />
                    <span className="min-w-0">
                      <span className="block font-medium">{t("sharedMcpService")}</span>
                      <span className="block text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("sharedMcpServiceDesc")}</span>
                    </span>
                  </label>
                </div>
              )}

              {!mcpDisabled && draft.mcpPolicy.includeSharedMcp && (
                <div className="mt-4">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="text-xs font-medium" style={{ color: "var(--app-text-secondary)" }}>{t("sharedMcpSelection")}</div>
                    <Badge variant="secondary" className="text-[10px]">
                      {sharedMcpSelectedCount}/{servers.length}
                    </Badge>
                  </div>
                  {servers.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                      {t("sharedMcpEmpty")}
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-2">
                      {servers.map((server) => {
                        const checked = isSharedMcpServerSelected(draft.mcpPolicy, server.name);
                        return (
                          <label
                            key={server.name}
                            className={cn(
                              "flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                              checked ? "border-primary/60 bg-primary/10" : "border-border",
                            )}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleServer(server.name)}
                            />
                            <span className="min-w-0 flex-1 truncate">{server.name}</span>
                            <Badge variant={server.status === "Running" ? "default" : "secondary"} className="text-[10px]">
                              {typeof server.status === "string" ? server.status : "Failed"}
                            </Badge>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {mcpManagerOpen && (
                <div className="mt-4 max-h-[540px] overflow-y-auto rounded-lg border border-border bg-background p-3">
                  <SharedMcpSection />
                </div>
              )}
            </Section>

            <Section
              title="Skill"
              description={t("sectionSkillDesc")}
              icon={<Sparkles size={16} />}
            >
              <div className="flex flex-wrap gap-2">
                {(["core", "custom", "disabled"] as const).map((mode) => (
                  <Button
                    key={mode}
                    size="sm"
                    variant={draft.skillPolicy.mode === mode ? "default" : "outline"}
                    onClick={() => setSkillMode(mode)}
                  >
                    {t(`skillMode.${mode}`)}
                  </Button>
                ))}
              </div>

              <div className="mt-4 rounded-md border border-border bg-background px-3 py-2 text-xs" style={{ color: "var(--app-text-secondary)" }}>
                {draft.skillPolicy.mode === "disabled"
                  ? t("skillDisabledHint")
                  : draft.skillPolicy.mode === "custom"
                    ? t("skillCustomHint")
                    : t("skillDefaultHint")}
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="text-xs font-medium" style={{ color: "var(--app-text-secondary)" }}>{t("builtinSkill")}</div>
                  <Badge variant="secondary" className="text-[10px]">
                    {builtinSkillSelectedCount}/{BUILTIN_SKILLS.length}
                  </Badge>
                </div>
                <div className="flex gap-2">
                  <Button size="xs" variant="outline" onClick={selectAllBuiltinSkills}>
                    {t("common:selectAll")}
                  </Button>
                  <Button size="xs" variant="outline" onClick={clearBuiltinSkills}>
                    {t("clear")}
                  </Button>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-2">
                {BUILTIN_SKILLS.map((name) => {
                  const checked = isBuiltinSkillSelected(draft.skillPolicy, name);
                  return (
                    <label
                      key={name}
                      className={cn(
                        "flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                        checked ? "border-primary/60 bg-primary/10" : "border-border",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSkill(name)}
                      />
                      <span className="min-w-0 flex-1 truncate">{name}</span>
                      <Badge variant="secondary" className="text-[10px]">{t("builtinBadge")}</Badge>
                    </label>
                  );
                })}
              </div>

              {visibleExternalSkillGroups.length > 0 && (
              <div className="mt-5 rounded-lg border border-border bg-background p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <div className="text-xs font-medium" style={{ color: "var(--app-text-secondary)" }}>
                        External Skills
                      </div>
                      <Badge variant="secondary" className="text-[10px]">
                        {externalSkillSelectedCount}/{visibleExternalSkills.length}
                      </Badge>
                    </div>
                    <div className="mt-1 text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
                      {t("externalSkillHint")}
                    </div>
                  </div>
                  <Button size="xs" variant="outline" disabled={skillMarketLoading} onClick={refreshSkillMarket}>
                    {skillMarketLoading ? t("refreshing") : t("refresh")}
                  </Button>
                </div>

                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {visibleExternalSkillGroups.map((group) => {
                    const included = isExternalSourceIncluded(draft.skillPolicy, group.kind);
                    return (
                      <label
                        key={group.kind}
                        className={cn(
                          "flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs transition-colors",
                          included ? "border-primary/60 bg-primary/10" : "border-border",
                        )}
                      >
                        <span>{group.label}</span>
                        <input
                          type="checkbox"
                          checked={included}
                          onChange={(event) => toggleExternalSource(group.kind, event.target.checked)}
                        />
                      </label>
                    );
                  })}
                </div>

                <div className="mt-3 space-y-2">
                  {skillMarketLoading && visibleExternalSkills.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                      {t("loadingExternalSkills")}
                    </div>
                  ) : visibleExternalSkills.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                      {t("noExternalSkills", { sources: visibleExternalSkillGroups.map((group) => group.label).join(", ") })}
                    </div>
                  ) : externalSkillGroups.map((group) => {
                    const included = isExternalSourceIncluded(draft.skillPolicy, group.kind);
                    const selectedCount = selectedExternalSkillCount(draft.skillPolicy, group.skills);
                    return (
                      <details key={group.kind} className="rounded-md border border-border px-3 py-2" open={included}>
                        <summary className="cursor-pointer text-xs font-medium" style={{ color: "var(--app-text-secondary)" }}>
                          {group.label} ({selectedCount}/{group.skills.length})
                        </summary>
                        <div className="mt-2 grid grid-cols-1 gap-2">
                          {group.skills.length === 0 ? (
                            <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                              {t("noSkillInSource")}
                            </div>
                          ) : group.skills.map((skill) => {
                            const checked = isExternalSkillSelected(draft.skillPolicy, skill);
                            return (
                              <label
                                key={skill.id}
                                className={cn(
                                  "flex items-start gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                                  checked ? "border-primary/60 bg-primary/10" : "border-border",
                                  !included && "opacity-60",
                                )}
                              >
                                <input
                                  type="checkbox"
                                  className="mt-0.5"
                                  checked={checked}
                                  disabled={!included}
                                  onChange={() => toggleExternalSkill(skill)}
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate font-medium">{skill.name}</span>
                                  {skill.description && (
                                    <span className="block line-clamp-2 text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                                      {skill.description}
                                    </span>
                                  )}
                                </span>
                                <Badge variant="secondary" className="shrink-0 text-[10px]">{group.label}</Badge>
                              </label>
                            );
                          })}
                        </div>
                      </details>
                    );
                  })}
                </div>
              </div>
              )}

              <div className="mt-5 rounded-lg border border-border bg-background p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <div className="text-xs font-medium" style={{ color: "var(--app-text-secondary)" }}>
                        {t("skillMarket")}
                      </div>
                      <Badge variant="secondary" className="text-[10px]">
                        {userSkillSelectedCount}/{userSkills.length}
                      </Badge>
                    </div>
                    <div className="mt-1 text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
                      {t("skillMarketHint")}
                    </div>
                  </div>
                  <Button size="xs" variant="outline" disabled={skillMarketLoading} onClick={refreshSkillMarket}>
                    {skillMarketLoading ? t("refreshing") : t("refresh")}
                  </Button>
                </div>

                <div className="mt-3 grid grid-cols-1 gap-2">
                  {skillMarketLoading && marketEntries.length === 0 && standaloneUserSkills.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                      {t("loadingMarket")}
                    </div>
                  ) : marketEntries.length === 0 && standaloneUserSkills.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                      {t("noMarketEntries")}
                    </div>
                  ) : (
                    <>
                      {marketEntries.map((entry) => {
                        const installed = installedUserSkillIds.has(entry.id);
                        const checked = installed && isUserSkillSelected(draft.skillPolicy, entry.id);
                        const installable = installableMarketEntry(entry);
                        return (
                          <div
                            key={entry.id}
                            className={cn(
                              "flex items-start gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                              checked ? "border-primary/60 bg-primary/10" : "border-border",
                            )}
                          >
                            <input
                              type="checkbox"
                              className="mt-0.5"
                              checked={checked}
                              disabled={!installed}
                              onChange={() => toggleUserSkill(entry.id)}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="truncate font-medium">{entry.name}</span>
                                {entry.recommended && <Badge variant="secondary" className="text-[10px]">{t("recommendedBadge")}</Badge>}
                                {entry.category && <Badge variant="outline" className="text-[10px]">{entry.category}</Badge>}
                              </div>
                              {entry.description && (
                                <div className="mt-1 line-clamp-2 text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                                  {entry.description}
                                </div>
                              )}
                              <div className="mt-1 flex flex-wrap gap-2 text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
                                <span>v{entry.version}</span>
                                {entry.license ? <span>{entry.license}</span> : <span>{t("missingLicense")}</span>}
                              </div>
                            </div>
                            {installed ? (
                              <Badge variant="secondary" className="shrink-0 text-[10px]">{t("installed")}</Badge>
                            ) : (
                              <Button
                                size="xs"
                                variant="outline"
                                className="shrink-0"
                                disabled={!installable || installingSkillId === entry.id}
                                onClick={() => installAndEnableSkill(entry)}
                                title={installable ? t("installTitle") : t("installBlockedTitle")}
                              >
                                {installingSkillId === entry.id ? t("installing") : t("installAndEnable")}
                              </Button>
                            )}
                          </div>
                        );
                      })}
                      {standaloneUserSkills.map((skill) => {
                        const checked = isUserSkillSelected(draft.skillPolicy, skill.id);
                        return (
                          <label
                            key={skill.id}
                            className={cn(
                              "flex items-start gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                              checked ? "border-primary/60 bg-primary/10" : "border-border",
                            )}
                          >
                            <input
                              type="checkbox"
                              className="mt-0.5"
                              checked={checked}
                              onChange={() => toggleUserSkill(skill.id)}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-medium">{skill.name}</span>
                              {skill.description && (
                                <span className="block truncate text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                                  {skill.description}
                                </span>
                              )}
                            </span>
                            <Badge variant="secondary" className="shrink-0 text-[10px]">{t("userLibBadge")}</Badge>
                          </label>
                        );
                      })}
                    </>
                  )}
                </div>
              </div>

              <div className="mt-5 rounded-lg border border-border bg-background p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <div className="text-xs font-medium" style={{ color: "var(--app-text-secondary)" }}>
                        {t("profileSkill")}
                      </div>
                      <Badge variant="secondary" className="text-[10px]">
                        {profileSkillSelectedCount}/{draft.skillPolicy.profileSkills.length}
                      </Badge>
                    </div>
                    <div className="mt-1 text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
                      {t("profileSkillHint")}
                    </div>
                  </div>
                  <Button size="xs" variant="outline" onClick={beginNewProfileSkill}>
                    <Plus size={12} /> {t("add")}
                  </Button>
                </div>

                {profileSkillEditorOpen && (
                  <div className="mt-3 rounded-md border border-primary/40 bg-[var(--app-content)] p-3">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <div className="text-xs font-semibold" style={{ color: "var(--app-text-primary)" }}>
                        {editingProfileSkillId ? t("editProfileSkill") : t("newProfileSkill")}
                      </div>
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={cancelProfileSkillEdit}>
                        <X size={13} />
                      </Button>
                    </div>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <Field label={t("fieldName")}>
                        <input
                          className={inputClass}
                          value={profileSkillForm.name}
                          onChange={(event) => setProfileSkillForm({ ...profileSkillForm, name: event.target.value })}
                          placeholder="review-guard"
                        />
                      </Field>
                      <Field label={t("fieldDescription")}>
                        <input
                          className={inputClass}
                          value={profileSkillForm.description}
                          onChange={(event) => setProfileSkillForm({ ...profileSkillForm, description: event.target.value })}
                          placeholder={t("profileSkillDescPlaceholder")}
                        />
                      </Field>
                    </div>
                    <div className="mt-3">
                      <Field label={t("fieldContent")}>
                        <textarea
                          className="min-h-28 w-full rounded-md border bg-background px-3 py-2 text-sm"
                          value={profileSkillForm.content}
                          onChange={(event) => setProfileSkillForm({ ...profileSkillForm, content: event.target.value })}
                          placeholder={t("profileSkillContentPlaceholder")}
                        />
                      </Field>
                    </div>
                    <div className="mt-3 flex justify-end gap-2">
                      <Button size="xs" variant="outline" onClick={cancelProfileSkillEdit}>
                        {t("common:cancel")}
                      </Button>
                      <Button size="xs" onClick={saveProfileSkill}>
                        <Save size={12} /> {t("saveSkill")}
                      </Button>
                    </div>
                  </div>
                )}

                <div className="mt-3 grid grid-cols-1 gap-2">
                  {draft.skillPolicy.profileSkills.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                      {t("profileSkillEmpty")}
                    </div>
                  ) : draft.skillPolicy.profileSkills.map((skill) => {
                    const checked = isProfileSkillSelected(draft.skillPolicy, skill.id);
                    return (
                      <label
                        key={skill.id}
                        className={cn(
                          "flex items-start gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                          checked ? "border-primary/60 bg-primary/10" : "border-border",
                        )}
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={checked}
                          onChange={() => toggleProfileSkill(skill.id)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{skill.name}</span>
                          {skill.description && (
                            <span className="block truncate text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                              {skill.description}
                            </span>
                          )}
                        </span>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6 shrink-0"
                          onClick={(event) => {
                            event.preventDefault();
                            beginEditProfileSkill(skill.id);
                          }}
                        >
                          <Pencil size={12} />
                        </Button>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6 shrink-0 text-destructive"
                          onClick={(event) => {
                            event.preventDefault();
                            deleteProfileSkill(skill.id);
                          }}
                        >
                          <Trash2 size={12} />
                        </Button>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="mt-5 rounded-lg border border-border bg-background p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-medium" style={{ color: "var(--app-text-secondary)" }}>
                      {t("workspaceProjectSkill")}
                    </div>
                    <div className="mt-1 text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
                      {workspaceContext
                        ? t("projectSkillWorkspaceHint")
                        : t("projectSkillSelectHint")}
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-xs" style={{ color: "var(--app-text-secondary)" }}>
                    <input
                      type="checkbox"
                      checked={draft.skillPolicy.includeProjectSkills}
                      onChange={(event) => setDraft({ ...draft, skillPolicy: { ...draft.skillPolicy, includeProjectSkills: event.target.checked } })}
                    />
                    {t("enableProjectSkill")}
                  </label>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!workspaceContext || workspaceContext.projects.length !== 1}
                    onClick={() => {
                      const project = workspaceContext?.projects[0];
                      if (project) openProjectSkillManager(project.path, project.alias || project.path);
                    }}
                  >
                    <Plus size={12} /> {t("addProjectSkill")}
                  </Button>
                </div>
                {workspaceContext ? (
                  workspaceContext.projects.length > 0 ? (
                    <div className="mt-3 grid grid-cols-1 gap-2">
                      {workspaceContext.projects.map((project) => (
                        <div
                          key={project.id}
                          className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
                        >
                          <span className="min-w-0 flex-1 truncate">{project.alias || project.path}</span>
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => openProjectSkillManager(project.path, project.alias || project.path)}
                          >
                            <Plus size={12} /> {t("addOrEdit")}
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-3 rounded-md border border-dashed border-border px-3 py-5 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                      {t("noProjects")}
                    </div>
                  )
                ) : null}
              </div>
            </Section>
          </div>
        </div>
        </main>
      </div>
    </div>
  );
}
