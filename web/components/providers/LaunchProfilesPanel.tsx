import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Cable, KeyRound, Layers3, Link2, Pencil, Plus, Save, Settings2, Sparkles, Star, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useLaunchProfilesStore, usePanesStore, useProvidersStore, useSharedMcpStore, useWorkspacesStore } from "@/stores";
import type { DiscoveredExternalSkill, InstalledUserSkill, LaunchProfile, LaunchProfileDraft, LaunchProfileResolution, LaunchProfileRuntime, SkillMarketEntry } from "@/types";
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

const MCP_MODE_LABELS: Record<LaunchProfileDraft["mcpPolicy"]["mode"], string> = {
  default: "默认组合",
  custom: "自定义选择",
  disabled: "不注入",
};

const SKILL_MODE_LABELS: Record<LaunchProfileDraft["skillPolicy"]["mode"], string> = {
  core: "默认组合",
  custom: "自定义选择",
  disabled: "不注入",
};

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
  none: "终端",
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  kimi: "Kimi",
  glm: "GLM",
  opencode: "OpenCode",
  cursor: "Cursor",
};

const RUNTIME_LABELS: Record<Exclude<LaunchProfileRuntime, null>, string> = {
  local: "本机",
  wsl: "WSL",
  ssh: "SSH",
};

const panelClass = "rounded-lg border border-border bg-[var(--app-content)]";
const inputClass = "h-9 w-full rounded-md border bg-background px-3 text-sm disabled:opacity-70";

function toolLabel(tool: KnownCliTool | string): string {
  return TOOL_LABELS[tool as KnownCliTool] ?? tool;
}

function profileMatchesTool(profile: Pick<LaunchProfile, "targetTools">, tool: KnownCliTool): boolean {
  return profile.targetTools.length === 0 || profile.targetTools.includes(tool);
}

function launchEnvironmentLabel(targetTools: string[], fallbackTool: KnownCliTool): string {
  return toolLabel(targetTools[0] ?? fallbackTool);
}

function runtimeLabel(runtime?: LaunchProfileRuntime): string {
  return runtime ? RUNTIME_LABELS[runtime] : "全部位置";
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

function draftDisplayName(draft: Pick<LaunchProfileDraft, "name" | "alias">): string {
  return draft.alias?.trim() || draft.name?.trim() || "运行配置";
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

function systemDefaultLaunchProfileDraft(tool: KnownCliTool, runtime: LaunchProfileRuntime = null): LaunchProfileDraft {
  return {
    name: `${toolLabel(tool)} 系统默认配置`,
    alias: `${toolLabel(tool)} 系统默认配置`,
    description: "不注入 Provider，尊重 CLI 自身配置、CC Switch live config 和用户环境；CC-Panes 只附加自己的 MCP 与 Skill 能力。",
    providerId: null,
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
  const [draft, setDraft] = useState<LaunchProfileDraft>(() => systemDefaultLaunchProfileDraft(initialTool, initialRuntime));
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
      setDraft((current) => toolDefaultProfile ? toDraft(toolDefaultProfile) : systemDefaultLaunchProfileDraft(activeTool, current.targetRuntime ?? null));
    }
  }, [activeTool, profiles, selectedId, toolDefaultProfile]);

  useEffect(() => {
    if (selectedId === SYSTEM_DEFAULT_PROFILE_ID) {
      setDraft((current) => toolDefaultProfile ? toDraft(toolDefaultProfile) : systemDefaultLaunchProfileDraft(activeTool, current.targetRuntime ?? null));
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
  const providerDisabled = isSystemDefaultSelected;
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
      toast.error(`加载 Skill 失败: ${String(error)}`);
    } finally {
      setSkillMarketLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshSkillMarket();
  }, [refreshSkillMarket]);

  useEffect(() => {
    if (selectedId === null || selectedId === SYSTEM_DEFAULT_PROFILE_ID) return;
    if (!filteredProfiles.some((profile) => profile.id === selectedId)) {
      setSelectedId(SYSTEM_DEFAULT_PROFILE_ID);
      setDraft((current) => toolDefaultProfile ? toDraft(toolDefaultProfile) : systemDefaultLaunchProfileDraft(activeTool, current.targetRuntime ?? null));
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
    setDraft(systemDefaultLaunchProfileDraft(tool, draft.targetRuntime ?? null));
    resetTransientState();
  }, [activeTool, draft.targetRuntime, onActiveToolChange, resetTransientState]);

  const handleSelectSystemDefault = useCallback(() => {
    setSelectedId(SYSTEM_DEFAULT_PROFILE_ID);
    setDraft((current) => toolDefaultProfile ? toDraft(toolDefaultProfile) : systemDefaultLaunchProfileDraft(activeTool, current.targetRuntime ?? null));
    resetTransientState();
  }, [activeTool, resetTransientState, toolDefaultProfile]);

  const handleSelect = useCallback((profile: LaunchProfile) => {
    setSelectedId(profile.id);
    setDraft(toDraft(profile));
    resetTransientState();
  }, [resetTransientState]);

  const handleCopySystemDefault = useCallback(() => {
    const base = selectedId === SYSTEM_DEFAULT_PROFILE_ID ? draft : systemDefaultLaunchProfileDraft(activeTool, draft.targetRuntime ?? null);
    setSelectedId(null);
    setDraft({
      ...base,
      name: `${toolLabel(activeTool)} 运行配置`,
      alias: `${toolLabel(activeTool)} 运行配置`,
      targetTools: [activeTool],
      targetRuntime: draft.targetRuntime ?? null,
      isDefault: false,
    });
    setPreview(null);
    setMcpManagerOpen(false);
    setWorkspaceBindingOpen(false);
    setBindingWorkspaceName(null);
    toast.success(`已创建 ${toolLabel(activeTool)} 运行配置草稿，保存后生效`);
  }, [activeTool, draft, selectedId]);

  const handleSave = useCallback(async () => {
    try {
      const alias = draft.alias?.trim() || draft.name?.trim() || `${toolLabel(activeTool)} 运行配置`;
      const nextDraft = {
        ...draft,
        name: draft.name?.trim() || alias,
        alias,
        providerId: isSystemDefaultSelected ? null : draft.providerId,
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
        toast.success("系统默认配置已保存");
        return;
      }

      if (!selectedProfile && workspaceContext) {
        await updateWorkspaceLaunchProfile(workspaceContext.name, saved.id);
      }
      setSelectedId(saved.id);
      setDraft(toDraft(saved));
      toast.success(workspaceContext && !selectedProfile
        ? `运行配置已保存并绑定到 ${workspaceContext.name}`
        : "运行配置已保存");
    } catch (error) {
      toast.error(`保存失败: ${String(error)}`);
    }
  }, [activeTool, createProfile, draft, isSystemDefaultSelected, selectedProfile, toolDefaultProfile, updateProfile, updateWorkspaceLaunchProfile, workspaceContext]);

  const handleDelete = useCallback(async () => {
    if (!selectedProfile || isSystemDefaultSelected) return;
    try {
      for (const workspace of workspaces.filter((item) => item.launchProfileId === selectedProfile.id)) {
        await updateWorkspaceLaunchProfile(workspace.name, null);
      }
      await removeProfile(selectedProfile.id);
      setSelectedId(SYSTEM_DEFAULT_PROFILE_ID);
      setDraft((current) => toolDefaultProfile ? toDraft(toolDefaultProfile) : systemDefaultLaunchProfileDraft(activeTool, current.targetRuntime ?? null));
      toast.success("运行配置已删除");
    } catch (error) {
      toast.error(`删除失败: ${String(error)}`);
    }
  }, [activeTool, isSystemDefaultSelected, removeProfile, selectedProfile, toolDefaultProfile, updateWorkspaceLaunchProfile, workspaces]);

  const handleSetDefault = useCallback(async () => {
    if (!selectedProfile) return;
    await setDefaultProfile(selectedProfile.id);
    toast.success("默认运行配置已更新");
  }, [selectedProfile, setDefaultProfile]);

  const handleToggleWorkspaceBinding = useCallback(async (workspaceName: string, checked: boolean) => {
    if (!selectedProfileId) {
      toast.info("请先保存运行配置");
      return;
    }
    setBindingWorkspaceName(workspaceName);
    try {
      await updateWorkspaceLaunchProfile(workspaceName, checked ? selectedProfileId : null);
      toast.success(checked ? `已绑定到 ${workspaceName}` : `已从 ${workspaceName} 解绑`);
    } catch (error) {
      toast.error(`工作空间绑定失败: ${String(error)}`);
    } finally {
      setBindingWorkspaceName(null);
    }
  }, [selectedProfileId, updateWorkspaceLaunchProfile]);

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
      toast.success(`已安装并启用 ${installed.name}`);
    } catch (error) {
      toast.error(`安装 Skill 失败: ${String(error)}`);
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
      toast.error("运行配置 Skill 的名称和内容不能为空");
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
    ? "CLI / CC Switch / 用户环境"
    : preview?.providerName ?? "未指定 Provider";
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
  const currentTitle = isSystemDefaultSelected ? `${toolLabel(activeTool)} 系统默认配置` : isNewProfile ? draftDisplayName(draft) : draftDisplayName(draft);

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
              <span>运行配置</span>
            </div>
            <div className="mt-1 text-xs" style={{ color: "var(--app-text-tertiary)" }}>
              先选择 CLI，再管理对应的 Provider、MCP、Skill 启动组合
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
              <span className="truncate">{toolLabel(activeTool)} 配置列表</span>
            </div>
            <Button size="xs" variant="outline" onClick={handleCopySystemDefault}>
              <Plus size={12} /> 新增
            </Button>
          </div>
          <div className="mt-1 text-xs" style={{ color: "var(--app-text-tertiary)" }}>
            {workspaceContext ? `仅显示 ${workspaceContext.name} 绑定和当前默认配置` : "全部工作空间可用的运行配置"}
          </div>
          <select
            className="mt-3 h-8 w-full rounded-md border bg-background px-2 text-xs"
            value={workspaceFilterName}
            onChange={(event) => setWorkspaceFilterName(event.target.value)}
          >
            <option value={WORKSPACE_FILTER_ALL}>全部工作空间</option>
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
                {toolLabel(activeTool)} 系统默认配置
              </span>
              <Badge variant="secondary" className="text-[10px]">默认</Badge>
            </div>
            <div className="mt-1 text-xs leading-5" style={{ color: "var(--app-text-secondary)" }}>
              Provider 不注入，MCP / Skill 可保存默认组合
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <span className="rounded-md border border-border px-1.5 py-0.5 text-[10px]">CC-Panes MCP</span>
              <span className="rounded-md border border-border px-1.5 py-0.5 text-[10px]">核心 Skill</span>
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
                  {profile.isDefault && <Badge variant="secondary" className="text-[10px]">默认</Badge>}
                  {workspaceContext && workspaceBoundProfileIds.has(profile.id) && (
                    <Badge variant="outline" className="text-[10px]">工作空间</Badge>
                  )}
                </div>
                <div className="mt-1 truncate text-xs" style={{ color: "var(--app-text-secondary)" }}>
                  {providers.find((p) => p.id === profile.providerId)?.name ?? "未指定 Provider"}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>
                  <span>{launchEnvironmentLabel(profile.targetTools, activeTool)}</span>
                  <span className="rounded-md border border-border px-1.5 py-0.5">
                    {runtimeLabel(profile.targetRuntime ?? null)}
                  </span>
                </div>
              </button>
            ))}
          </div>

          {filteredProfiles.length === 0 && (
            <div className="px-2 py-4 text-xs leading-5" style={{ color: "var(--app-text-tertiary)" }}>
              {workspaceContext
                ? "这个工作空间还没有绑定自定义运行配置。点击“新增”会创建并绑定到当前工作空间。"
                : "当前 CLI 还没有自定义配置。点击“新增”会从系统默认配置创建草稿。"}
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
                  {(isSystemDefaultSelected || selectedProfile?.isDefault) && <Badge variant="secondary" className="text-[10px]">默认</Badge>}
                  {!isSystemDefaultSelected && (
                    <Badge variant="outline" className="text-[10px]">{toolLabel(activeTool)}</Badge>
                  )}
                  <Badge variant="outline" className="text-[10px]">{runtimeLabel(draft.targetRuntime ?? null)}</Badge>
                </div>
                <p className="mt-1 max-w-2xl text-xs leading-5" style={{ color: "var(--app-text-secondary)" }}>
                  {isSystemDefaultSelected
                    ? `${toolLabel(activeTool)} 系统默认配置是启动基线。Provider 不注入，MCP 与 Skill 可按当前环境保存默认组合。`
                    : "运行配置用于一次启动时组合 Provider、MCP 与 Skill，可绑定到工作空间或设为当前 CLI 的默认。"}
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
                      <Link2 size={14} /> {selectedProfileId ? `工作空间绑定 ${boundWorkspaces.length}` : "保存后绑定"}
                    </Button>
                    <Button size="sm" variant="outline" onClick={handleCopySystemDefault}>
                      <Plus size={14} /> 复制为运行配置
                    </Button>
                    <Button size="sm" onClick={handleSave}>
                      <Save size={14} /> 保存默认
                    </Button>
                  </>
                ) : (
                  <>
                    {selectedProfile && !selectedProfile.isDefault && (
                      <Button size="sm" variant="outline" onClick={handleSetDefault}>
                        <Star size={14} /> 设为默认
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant={selectedProfile ? "default" : "outline"}
                      disabled={!selectedProfile}
                      onClick={() => setWorkspaceBindingOpen((value) => !value)}
                    >
                      <Link2 size={14} /> {selectedProfile ? `工作空间绑定 ${boundWorkspaces.length}` : "保存后绑定"}
                    </Button>
                    {selectedProfile && (
                      <Button size="sm" variant="outline" onClick={handleDelete}>
                        <Trash2 size={14} /> 删除
                      </Button>
                    )}
                    <Button size="sm" onClick={handleSave}>
                      <Save size={14} /> {isNewProfile ? "保存为运行配置" : "保存"}
                    </Button>
                  </>
                )}
              </div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-4">
              <PreviewItem label="Provider" value={previewProviderLabel} />
              <PreviewItem label="MCP" value={`${previewMcpCount} 个启用`} />
              <PreviewItem label="Skill" value={`${previewSkillCount} 个启用`} />
              <PreviewItem
                label="工作空间"
                value={selectedProfileId ? `${boundWorkspaces.length} 个绑定` : "未保存"}
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
                    工作空间绑定
                  </div>
                  <Badge variant="default" className="text-[10px]">
                    {boundWorkspaces.length}
                  </Badge>
                </div>
                {workspacesLoading && workspaces.length === 0 ? (
                  <div className="text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                    正在加载工作空间...
                  </div>
                ) : workspaces.length === 0 ? (
                  <div className="text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                    暂无工作空间。
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
                        : workspace.launchProfileId ? workspace.launchProfileId : "未绑定";
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
                            {checked ? "当前配置" : currentLabel}
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
              title="基础"
              description="设置别名、限定适用 CLI，并选择要显式注入的 Provider。"
              icon={<KeyRound size={16} />}
            >
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Field label="别名">
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
                    <option value="">未指定 Provider</option>
                    {providerOptions.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                  </select>
                </Field>
              </div>
              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                <Field label="适用 CLI">
                  <div className={cn(inputClass, "flex items-center")}>
                    {toolLabel(activeTool)}
                  </div>
                </Field>
                <Field label="运行位置">
                  <select
                    className={inputClass}
                    value={draft.targetRuntime ?? ""}
                    onChange={(event) => setDraft({
                      ...draft,
                      targetRuntime: event.target.value ? event.target.value as Exclude<LaunchProfileRuntime, null> : null,
                    })}
                  >
                    <option value="">全部位置</option>
                    <option value="local">本机</option>
                    <option value="wsl">WSL</option>
                    <option value="ssh">SSH</option>
                  </select>
                </Field>
              </div>
              <div className="mt-1 text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
                运行配置固定归属当前 CLI；运行位置用于区分本机、WSL 与 SSH 的 CLI 配置。
              </div>
              <div className="mt-3">
                <Field label="说明">
                  <input
                    className={inputClass}
                    value={draft.description ?? ""}
                    onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                  />
                </Field>
              </div>
            </Section>

            <Section
              title="权限"
              description="设置当前运行配置的 CLI 权限策略。"
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
                        ⚠ 已绕过权限确认
                      </span>
                    ) : null}
                  </span>
                  <span className="block text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                    仅本次启动追加 CLI bypass 参数，不写入 Claude/Codex 用户配置。
                  </span>
                </span>
              </label>

              {yoloConfirmOpen && !draft.yoloMode ? (
                <div className="mt-2 rounded-md border border-destructive/60 bg-destructive/10 px-3 py-2 text-xs leading-5">
                  <p className="font-medium text-destructive">确认开启 YOLO？</p>
                  <p className="mt-1" style={{ color: "var(--app-text-tertiary)" }}>
                    会让本配置启动的 CLI 跳过权限 / 沙箱确认（Claude：--dangerously-skip-permissions，Codex：bypass approvals and sandbox），可能在无人确认下执行危险命令。仅在你完全信任该工作区时开启。
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
                      确认开启
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setYoloConfirmOpen(false)}
                    >
                      取消
                    </Button>
                  </div>
                </div>
              ) : null}

              <div className="mt-3 text-[11px] leading-5" style={{ color: "var(--app-text-tertiary)" }}>
                Claude 使用 skip permissions；Codex 使用 bypass approvals and sandbox。其他 CLI 会保存此标记，但不会追加未知参数。
              </div>
            </Section>

            <Section
              title="预览"
              description="按当前选中的工作空间解析最终启动结果。"
              icon={<Layers3 size={16} />}
            >
              {isNewProfile ? (
                <div className="text-xs leading-5" style={{ color: "var(--app-text-tertiary)" }}>
                  保存后显示当前运行配置的解析结果。
                </div>
              ) : (
                <div className="space-y-3 text-xs">
                  {workspaceContext && (
                    <div style={{ color: "var(--app-text-secondary)" }}>
                      当前工作空间: <span className="font-medium">{workspaceContext.name}</span>
                    </div>
                  )}
                  {workspaceContext && (
                    <div style={{ color: "var(--app-text-secondary)" }}>
                      绑定配置: {workspaceContext.launchProfileId ? profileDisplayName(profiles.find((p) => p.id === workspaceContext.launchProfileId) ?? { name: workspaceContext.launchProfileId, alias: null }) : "未绑定"}
                    </div>
                  )}
                  {workspaces.length === 0 && (
                    <div style={{ color: "var(--app-text-tertiary)" }}>创建或选择工作空间后，可以预览项目 Skill。</div>
                  )}
                  {!workspaceContext && workspaces.length > 0 && (
                    <div style={{ color: "var(--app-text-tertiary)" }}>在左侧选择工作空间后，可以按该工作空间解析项目 Skill。</div>
                  )}
                  {preview?.warnings.map((warning) => (
                    <div key={warning} className="rounded-md border border-amber-500/30 px-3 py-2 text-amber-500">
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
              description="设置本运行配置启动时注入的 MCP 组合。"
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
                      {MCP_MODE_LABELS[mode]}
                    </Button>
                  ))}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setMcpManagerOpen((value) => !value)}
                >
                  <Settings2 size={14} />
                  {mcpManagerOpen ? "收起服务库" : "管理共享 MCP"}
                </Button>
              </div>

              <div className="mt-4 rounded-md border border-border bg-background px-3 py-2 text-xs" style={{ color: "var(--app-text-secondary)" }}>
                {mcpDisabled
                  ? "当前配置不会注入 CC-Panes MCP 或共享 MCP。"
                  : draft.mcpPolicy.mode === "custom"
                    ? "自定义模式只注入下方选中的共享 MCP。"
                    : "默认组合会使用 CC-Panes MCP，并启用共享服务库中未排除的 MCP。"}
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
                      <span className="block text-xs" style={{ color: "var(--app-text-tertiary)" }}>注入 CC-Panes 自身的任务、工作空间与编排能力。</span>
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
                      <span className="block font-medium">共享 MCP 服务</span>
                      <span className="block text-xs" style={{ color: "var(--app-text-tertiary)" }}>从共享服务库复用已配置的 MCP。</span>
                    </span>
                  </label>
                </div>
              )}

              {!mcpDisabled && draft.mcpPolicy.includeSharedMcp && (
                <div className="mt-4">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="text-xs font-medium" style={{ color: "var(--app-text-secondary)" }}>共享 MCP 选择</div>
                    <Badge variant="secondary" className="text-[10px]">
                      {sharedMcpSelectedCount}/{servers.length}
                    </Badge>
                  </div>
                  {servers.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                      共享服务库为空，可以通过“管理共享 MCP”新增或导入。
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
              description="设置本运行配置启动时注入的 Skill 组合。"
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
                    {SKILL_MODE_LABELS[mode]}
                  </Button>
                ))}
              </div>

              <div className="mt-4 rounded-md border border-border bg-background px-3 py-2 text-xs" style={{ color: "var(--app-text-secondary)" }}>
                {draft.skillPolicy.mode === "disabled"
                  ? "当前配置不会注入 CC-Panes 内置 Skill、运行配置 Skill 或工作空间项目 Skill。"
                  : draft.skillPolicy.mode === "custom"
                    ? "自定义模式只注入下方选中的 Skill。"
                    : "默认组合会启用 CC-Panes 内置 Skill、运行配置 Skill，并可附加工作空间项目 Skill。"}
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="text-xs font-medium" style={{ color: "var(--app-text-secondary)" }}>CC-Panes 内置 Skill</div>
                  <Badge variant="secondary" className="text-[10px]">
                    {builtinSkillSelectedCount}/{BUILTIN_SKILLS.length}
                  </Badge>
                </div>
                <div className="flex gap-2">
                  <Button size="xs" variant="outline" onClick={selectAllBuiltinSkills}>
                    全选
                  </Button>
                  <Button size="xs" variant="outline" onClick={clearBuiltinSkills}>
                    清空
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
                      <Badge variant="secondary" className="text-[10px]">内置</Badge>
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
                      Core 模式默认通过外部池；Custom 模式只允许勾选项。
                    </div>
                  </div>
                  <Button size="xs" variant="outline" disabled={skillMarketLoading} onClick={refreshSkillMarket}>
                    {skillMarketLoading ? "刷新中" : "刷新"}
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
                      正在加载外部 Skill...
                    </div>
                  ) : visibleExternalSkills.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                      未发现 {visibleExternalSkillGroups.map((group) => group.label).join("、")} 外部 Skill。
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
                              这个来源下暂无 Skill。
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
                        推荐 Skill 市场
                      </div>
                      <Badge variant="secondary" className="text-[10px]">
                        {userSkillSelectedCount}/{userSkills.length}
                      </Badge>
                    </div>
                    <div className="mt-1 text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
                      官方推荐 Skill 安装到用户库。只有安装并勾选后才会注入当前运行配置。
                    </div>
                  </div>
                  <Button size="xs" variant="outline" disabled={skillMarketLoading} onClick={refreshSkillMarket}>
                    {skillMarketLoading ? "刷新中" : "刷新"}
                  </Button>
                </div>

                <div className="mt-3 grid grid-cols-1 gap-2">
                  {skillMarketLoading && marketEntries.length === 0 && standaloneUserSkills.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                      正在加载官方 Skill 推荐...
                    </div>
                  ) : marketEntries.length === 0 && standaloneUserSkills.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                      暂无可用推荐。离线或官方索引不可用时不会影响已有运行配置。
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
                                {entry.recommended && <Badge variant="secondary" className="text-[10px]">推荐</Badge>}
                                {entry.category && <Badge variant="outline" className="text-[10px]">{entry.category}</Badge>}
                              </div>
                              {entry.description && (
                                <div className="mt-1 line-clamp-2 text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                                  {entry.description}
                                </div>
                              )}
                              <div className="mt-1 flex flex-wrap gap-2 text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
                                <span>v{entry.version}</span>
                                {entry.license ? <span>{entry.license}</span> : <span>缺少 license</span>}
                              </div>
                            </div>
                            {installed ? (
                              <Badge variant="secondary" className="shrink-0 text-[10px]">已安装</Badge>
                            ) : (
                              <Button
                                size="xs"
                                variant="outline"
                                className="shrink-0"
                                disabled={!installable || installingSkillId === entry.id}
                                onClick={() => installAndEnableSkill(entry)}
                                title={installable ? "安装到用户库并启用到当前运行配置" : "缺少 license、contentUrl 或 sha256，暂不能安装"}
                              >
                                {installingSkillId === entry.id ? "安装中" : "安装并启用"}
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
                            <Badge variant="secondary" className="shrink-0 text-[10px]">用户库</Badge>
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
                        运行配置 Skill
                      </div>
                      <Badge variant="secondary" className="text-[10px]">
                        {profileSkillSelectedCount}/{draft.skillPolicy.profileSkills.length}
                      </Badge>
                    </div>
                    <div className="mt-1 text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
                      保存在当前运行配置里，启动时通过 CC-Panes session context 注入，不写入用户项目。
                    </div>
                  </div>
                  <Button size="xs" variant="outline" onClick={beginNewProfileSkill}>
                    <Plus size={12} /> 新增
                  </Button>
                </div>

                {profileSkillEditorOpen && (
                  <div className="mt-3 rounded-md border border-primary/40 bg-[var(--app-content)] p-3">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <div className="text-xs font-semibold" style={{ color: "var(--app-text-primary)" }}>
                        {editingProfileSkillId ? "编辑运行配置 Skill" : "新增运行配置 Skill"}
                      </div>
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={cancelProfileSkillEdit}>
                        <X size={13} />
                      </Button>
                    </div>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <Field label="名称">
                        <input
                          className={inputClass}
                          value={profileSkillForm.name}
                          onChange={(event) => setProfileSkillForm({ ...profileSkillForm, name: event.target.value })}
                          placeholder="review-guard"
                        />
                      </Field>
                      <Field label="说明">
                        <input
                          className={inputClass}
                          value={profileSkillForm.description}
                          onChange={(event) => setProfileSkillForm({ ...profileSkillForm, description: event.target.value })}
                          placeholder="进入会话时附加的工作习惯或角色要求"
                        />
                      </Field>
                    </div>
                    <div className="mt-3">
                      <Field label="内容">
                        <textarea
                          className="min-h-28 w-full rounded-md border bg-background px-3 py-2 text-sm"
                          value={profileSkillForm.content}
                          onChange={(event) => setProfileSkillForm({ ...profileSkillForm, content: event.target.value })}
                          placeholder="写入这条运行配置 Skill 的完整指令。"
                        />
                      </Field>
                    </div>
                    <div className="mt-3 flex justify-end gap-2">
                      <Button size="xs" variant="outline" onClick={cancelProfileSkillEdit}>
                        取消
                      </Button>
                      <Button size="xs" onClick={saveProfileSkill}>
                        <Save size={12} /> 保存 Skill
                      </Button>
                    </div>
                  </div>
                )}

                <div className="mt-3 grid grid-cols-1 gap-2">
                  {draft.skillPolicy.profileSkills.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                      还没有运行配置 Skill。点击“新增”后会随当前运行配置保存。
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
                      工作空间项目 Skill
                    </div>
                    <div className="mt-1 text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
                      {workspaceContext
                        ? "项目 Skill 会写入项目的 .claude/commands，并随当前工作空间参与预览。"
                        : "左侧选择工作空间后，可以在这里新增或编辑项目 Skill。"}
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-xs" style={{ color: "var(--app-text-secondary)" }}>
                    <input
                      type="checkbox"
                      checked={draft.skillPolicy.includeProjectSkills}
                      onChange={(event) => setDraft({ ...draft, skillPolicy: { ...draft.skillPolicy, includeProjectSkills: event.target.checked } })}
                    />
                    启用项目 Skill
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
                    <Plus size={12} /> 新增项目 Skill
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
                            <Plus size={12} /> 新增 / 编辑
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-3 rounded-md border border-dashed border-border px-3 py-5 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                      当前工作空间还没有项目。
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
