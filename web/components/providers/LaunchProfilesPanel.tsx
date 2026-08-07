import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useLaunchProfilesStore, usePanesStore, useProvidersStore, useSharedMcpStore, useWorkspacesStore } from "@/stores";
import type { DiscoveredExternalSkill, LaunchProfile, LaunchProfileDraft, LaunchProfileResolution, LaunchProfileRuntime, SkillMarketEntry, Workspace } from "@/types";
import { useCliTools } from "@/hooks/useCliTools";
import { isProviderTypeCompatibleWithCli } from "@/utils/providerCompatibility";
import type { KnownCliTool } from "@/types/terminal";
import LaunchProfileBasicsCard from "./LaunchProfileBasicsCard";
import LaunchProfileListAside, {
  type LaunchProfileListMode,
} from "./LaunchProfileListAside";
import LaunchProfileMcpCard from "./LaunchProfileMcpCard";
import LaunchProfileSkillCard from "./LaunchProfileSkillCard";
import LaunchProfileSummaryCard from "./LaunchProfileSummaryCard";
import { useSkillMarketData } from "./useSkillMarketData";
import { useLaunchProfileSkillEditor } from "./useLaunchProfileSkillEditor";
import {
  SYSTEM_DEFAULT_PROFILE_ID,
  WORKSPACE_FILTER_ALL,
  draftDisplayName,
  profileMatchesTool,
  systemDefaultLaunchProfileDraft,
  toDraft,
  toolLabel,
  workspaceProfileIds,
  type ExternalSkillSourceKind,
} from "./launchProfileHelpers";
import {
  nextClearBuiltinSkills,
  nextEnableUserSkill,
  nextMcpMode,
  nextSelectAllBuiltinSkills,
  nextSkillMode,
  nextToggleBuiltinSkill,
  nextToggleExternalSkill,
  nextToggleExternalSource,
  nextToggleProfileSkill,
  nextToggleServer,
  nextToggleUserSkill,
} from "./launchProfileSkillPolicy";

interface LaunchProfilesPanelProps {
  compact?: boolean;
  initialTool?: KnownCliTool;
  /** 受控 CLI（chips 已上移到 ProviderPagesHeader，由父级切换后经此同步进来） */
  tool?: KnownCliTool;
  initialRuntime?: LaunchProfileRuntime;
  onActiveToolChange?: (tool: KnownCliTool) => void;
}

export default function LaunchProfilesPanel({
  compact,
  initialTool,
  tool,
  initialRuntime = null,
  onActiveToolChange,
}: LaunchProfilesPanelProps) {
  const { tools: cliTools } = useCliTools();
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

  const resolvedInitialTool = tool ?? initialTool ?? "claude";
  const [activeTool, setActiveTool] = useState<KnownCliTool>(resolvedInitialTool);
  const [selectedId, setSelectedId] = useState<string | null>(SYSTEM_DEFAULT_PROFILE_ID);
  const [draft, setDraft] = useState<LaunchProfileDraft>(() => systemDefaultLaunchProfileDraft(resolvedInitialTool, initialRuntime, t));
  const [preview, setPreview] = useState<LaunchProfileResolution | null>(null);
  const [mcpManagerOpen, setMcpManagerOpen] = useState(false);
  const [workspaceBindingOpen, setWorkspaceBindingOpen] = useState(false);
  const [bindingWorkspaceName, setBindingWorkspaceName] = useState<string | null>(null);
  const [workspaceFilterName, setWorkspaceFilterName] = useState(WORKSPACE_FILTER_ALL);
  const [listMode, setListMode] = useState<LaunchProfileListMode>("profiles");
  const {
    marketEntries,
    userSkills,
    externalSkills,
    skillMarketLoading,
    installingSkillId,
    refreshSkillMarket,
    installSkill,
  } = useSkillMarketData();
  const {
    profileSkillEditorOpen,
    editingProfileSkillId,
    profileSkillForm,
    setProfileSkillForm,
    beginNewProfileSkill,
    beginEditProfileSkill,
    cancelProfileSkillEdit,
    saveProfileSkill,
    deleteProfileSkill,
  } = useLaunchProfileSkillEditor(draft, setDraft);
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
  const providerDisabled = isSystemDefaultSelected;
  const profilesForActiveTool = useMemo(
    () => profiles.filter((profile) => profileMatchesTool(profile, activeTool)),
    [activeTool, profiles],
  );
  const filteredProfiles = useMemo(() => {
    if (!workspaceContext) return profilesForActiveTool;
    return profilesForActiveTool.filter(
      (profile) => profile.isDefault || workspaceBoundProfileIds.has(profile.id),
    );
  }, [profilesForActiveTool, workspaceBoundProfileIds, workspaceContext]);
  const compatibleProviders = useMemo(() => providers.filter((provider) => isProviderTypeCompatibleWithCli(provider.providerType, activeTool, cliTools)), [activeTool, cliTools, providers]);
  const selectedDraftProvider = providers.find((provider) => provider.id === draft.providerId);
  const selectedProviderModels = selectedDraftProvider?.models ?? [];
  const selectedProviderDefaultModel = selectedProviderModels.find(
    (model) => model.id === selectedDraftProvider?.defaultModelId,
  ) ?? selectedProviderModels[0];
  const selectedEffectiveModel = draft.modelId
    ? selectedProviderModels.find((model) => model.id === draft.modelId)
    : selectedProviderDefaultModel;
  const selectedProfileEffort = draft.adapterOptions?.effort;
  const providerOptions = selectedDraftProvider && !compatibleProviders.some((provider) => provider.id === selectedDraftProvider.id)
    ? [selectedDraftProvider, ...compatibleProviders]
    : compatibleProviders;

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
    cancelProfileSkillEdit();
  }, [cancelProfileSkillEdit]);

  const handleToolChange = useCallback((nextTool: KnownCliTool) => {
    if (nextTool === activeTool) return;
    setActiveTool(nextTool);
    onActiveToolChange?.(nextTool);
    setSelectedId(SYSTEM_DEFAULT_PROFILE_ID);
    setDraft(systemDefaultLaunchProfileDraft(nextTool, draft.targetRuntime ?? null, t));
    resetTransientState();
  }, [activeTool, draft.targetRuntime, onActiveToolChange, resetTransientState]);

  // chips 上移后 CLI 切换来自父级：受控 tool 变化时走同一条切换路径（选中/草稿/瞬态一并重置）
  useEffect(() => {
    if (tool && tool !== activeTool) handleToolChange(tool);
  }, [tool, activeTool, handleToolChange]);

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

  const handleListModeChange = useCallback((mode: LaunchProfileListMode) => {
    setListMode(mode);
    if (mode === "profiles") {
      setWorkspaceFilterName(WORKSPACE_FILTER_ALL);
    }
  }, []);

  const handleSelectWorkspace = useCallback((workspace: Workspace) => {
    setWorkspaceFilterName(workspace.name);
    const boundProfile = workspace.launchProfileId
      ? profiles.find(
          (profile) => profile.id === workspace.launchProfileId
            && profileMatchesTool(profile, activeTool),
        ) ?? null
      : null;

    if (boundProfile) {
      handleSelect(boundProfile);
      return;
    }

    handleSelectSystemDefault();
  }, [activeTool, handleSelect, handleSelectSystemDefault, profiles]);

  const handleSelectWorkspaceProfile = useCallback((workspace: Workspace, profile: LaunchProfile) => {
    setWorkspaceFilterName(workspace.name);
    handleSelect(profile);
  }, [handleSelect]);

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
        providerId: isSystemDefaultSelected ? null : draft.providerId,
        modelId: isSystemDefaultSelected || !draft.providerId ? null : draft.modelId,
        adapterOptions: draft.adapterOptions ?? {},
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
  }, [activeTool, createProfile, draft, isSystemDefaultSelected, selectedProfile, t, toolDefaultProfile, updateProfile, updateWorkspaceLaunchProfile, workspaceContext]);

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
    setDraft((current) => nextMcpMode(current, mode, servers));
  };
  const setSkillMode = (mode: LaunchProfileDraft["skillPolicy"]["mode"]) => {
    setDraft((current) => nextSkillMode(current, mode, externalSkills));
  };
  const toggleServer = (name: string) => {
    setDraft((current) => nextToggleServer(current, name));
  };
  const toggleSkill = (name: string) => {
    setDraft((current) => nextToggleBuiltinSkill(current, name));
  };
  const toggleProfileSkill = (id: string) => {
    setDraft((current) => nextToggleProfileSkill(current, id));
  };
  const toggleExternalSource = (kind: ExternalSkillSourceKind, included: boolean) => {
    setDraft((current) => nextToggleExternalSource(current, kind, included));
  };
  const toggleExternalSkill = (skill: DiscoveredExternalSkill) => {
    setDraft((current) => nextToggleExternalSkill(current, skill, externalSkills));
  };
  const toggleUserSkill = (id: string) => {
    setDraft((current) => nextToggleUserSkill(current, id, externalSkills));
  };
  const installAndEnableSkill = async (entry: SkillMarketEntry) => {
    // 安装动作在 hook 里，装完回调这里把它写进草稿（hook 不依赖 draft）
    await installSkill(entry, (installed) => {
      setDraft((current) => nextEnableUserSkill(current, installed.id, externalSkills));
    });
  };
  const selectAllBuiltinSkills = () => {
    setDraft(nextSelectAllBuiltinSkills);
  };
  const clearBuiltinSkills = () => {
    setDraft(nextClearBuiltinSkills);
  };

  const previewProviderLabel = isSystemDefaultSelected
    ? t("previewSystemProvider")
    : preview?.providerName ?? t("noProviderSpecified");
  const previewModelLabel = isSystemDefaultSelected
    ? t("nativeCliDefaultModel")
    : preview?.modelLabel ?? preview?.modelId ?? selectedProviderDefaultModel?.label
      ?? selectedProviderDefaultModel?.id ?? t("nativeCliDefaultModel");
  const previewMcpCount = preview?.mcpServers.filter((server) => server.enabled).length ?? 0;
  const previewSkillCount = preview?.skills.filter((skill) => skill.enabled).length ?? 0;
  const currentTitle = isSystemDefaultSelected ? t("systemDefaultName", { tool: toolLabel(activeTool, t) }) : isNewProfile ? draftDisplayName(draft, t) : draftDisplayName(draft, t);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className={`flex min-h-0 flex-1 overflow-hidden ${compact ? "flex-col" : "max-[760px]:flex-col"}`}>
        <LaunchProfileListAside
          compact={compact}
          activeTool={activeTool}
          workspaces={workspaces}
          workspaceContext={workspaceContext}
          listMode={listMode}
          onListModeChange={handleListModeChange}
          providers={providers}
          profiles={profiles}
          filteredProfiles={profilesForActiveTool}
          selectedId={selectedId}
          isSystemDefaultSelected={isSystemDefaultSelected}
          onCopySystemDefault={handleCopySystemDefault}
          onSelectSystemDefault={handleSelectSystemDefault}
          onSelect={handleSelect}
          onSelectWorkspaceProfile={handleSelectWorkspaceProfile}
          onSelectWorkspace={handleSelectWorkspace}
        />

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className={`mx-auto max-w-5xl space-y-2.5 ${compact ? "py-3" : "px-3 py-3"}`}>
            <LaunchProfileSummaryCard
              draft={draft}
              activeTool={activeTool}
              currentTitle={currentTitle}
              isSystemDefaultSelected={isSystemDefaultSelected}
              isNewProfile={isNewProfile}
              selectedProfile={selectedProfile}
              selectedProfileId={selectedProfileId}
              profiles={profiles}
              preview={preview}
              previewProviderLabel={previewProviderLabel}
              previewModelLabel={previewModelLabel}
              previewMcpCount={previewMcpCount}
              previewSkillCount={previewSkillCount}
              workspaces={workspaces}
              workspacesLoading={workspacesLoading}
              workspaceContext={workspaceContext}
              boundWorkspaces={boundWorkspaces}
              bindingWorkspaceName={bindingWorkspaceName}
              workspaceBindingOpen={workspaceBindingOpen}
              onToggleWorkspaceBindingOpen={() => setWorkspaceBindingOpen((value) => !value)}
              onToggleWorkspaceBinding={handleToggleWorkspaceBinding}
              onCopySystemDefault={handleCopySystemDefault}
              onSave={handleSave}
              onSetDefault={handleSetDefault}
              onDelete={handleDelete}
            />

            <LaunchProfileBasicsCard
              draft={draft}
              setDraft={setDraft}
              activeTool={activeTool}
              providerDisabled={providerDisabled}
              providerOptions={providerOptions}
              selectedProviderModels={selectedProviderModels}
              selectedProviderDefaultModel={selectedProviderDefaultModel}
              selectedEffectiveModel={selectedEffectiveModel}
              selectedProfileEffort={selectedProfileEffort}
              yoloConfirmOpen={yoloConfirmOpen}
              setYoloConfirmOpen={setYoloConfirmOpen}
            />

            <LaunchProfileMcpCard
              draft={draft}
              setDraft={setDraft}
              servers={servers}
              mcpManagerOpen={mcpManagerOpen}
              setMcpManagerOpen={setMcpManagerOpen}
              setMcpMode={setMcpMode}
              toggleServer={toggleServer}
            />

            <LaunchProfileSkillCard
              draft={draft}
              setDraft={setDraft}
              activeTool={activeTool}
              externalSkills={externalSkills}
              userSkills={userSkills}
              marketEntries={marketEntries}
              skillMarketLoading={skillMarketLoading}
              installingSkillId={installingSkillId}
              refreshSkillMarket={refreshSkillMarket}
              setSkillMode={setSkillMode}
              selectAllBuiltinSkills={selectAllBuiltinSkills}
              clearBuiltinSkills={clearBuiltinSkills}
              toggleSkill={toggleSkill}
              toggleExternalSource={toggleExternalSource}
              toggleExternalSkill={toggleExternalSkill}
              toggleUserSkill={toggleUserSkill}
              installAndEnableSkill={installAndEnableSkill}
              workspaceContext={workspaceContext}
              openProjectSkillManager={openSkillManager}
              profileSkillEditorOpen={profileSkillEditorOpen}
              editingProfileSkillId={editingProfileSkillId}
              profileSkillForm={profileSkillForm}
              setProfileSkillForm={setProfileSkillForm}
              beginNewProfileSkill={beginNewProfileSkill}
              beginEditProfileSkill={beginEditProfileSkill}
              cancelProfileSkillEdit={cancelProfileSkillEdit}
              saveProfileSkill={saveProfileSkill}
              toggleProfileSkill={toggleProfileSkill}
              deleteProfileSkill={deleteProfileSkill}
            />
          </div>
        </main>
      </div>
    </div>
  );
}
