import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useLaunchProfilesStore, usePanesStore, useProvidersStore, useSharedMcpStore, useWorkspacesStore } from "@/stores";
import type { DiscoveredExternalSkill, LaunchProfileDraft, LaunchProfileResolution, LaunchProfileRuntime, SkillMarketEntry } from "@/types";
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
import UnsavedChangesDialog from "./UnsavedChangesDialog";
import { useLaunchProfileUnsavedChanges } from "./useLaunchProfileUnsavedChanges";
import { useLaunchProfileNavigation } from "./useLaunchProfileNavigation";
import { useLaunchProfileDraft } from "./useLaunchProfileDraft";
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
  onDirtyChange?: (dirty: boolean) => void;
}

export default function LaunchProfilesPanel({
  compact,
  initialTool,
  tool,
  initialRuntime = null,
  onActiveToolChange,
  onDirtyChange,
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
  const { draft, setDraft, replaceDraft, userEditedRef } = useLaunchProfileDraft(() => systemDefaultLaunchProfileDraft(resolvedInitialTool, initialRuntime, t));
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
      replaceDraft((current) => toolDefaultProfile ? toDraft(toolDefaultProfile) : systemDefaultLaunchProfileDraft(activeTool, current.targetRuntime ?? null, t));
    }
  }, [activeTool, profiles, replaceDraft, selectedId, toolDefaultProfile]);

  useEffect(() => {
    if (selectedId === SYSTEM_DEFAULT_PROFILE_ID && !(toolDefaultProfile && userEditedRef.current)) {
      replaceDraft((current) => toolDefaultProfile ? toDraft(toolDefaultProfile) : systemDefaultLaunchProfileDraft(activeTool, current.targetRuntime ?? null, t));
    }
  }, [activeTool, replaceDraft, selectedId, toolDefaultProfile, userEditedRef]);

  useEffect(() => {
    if (selectedId === null || selectedId === SYSTEM_DEFAULT_PROFILE_ID) return;
    const profile = profiles.find((item) => item.id === selectedId);
    if (profile && !userEditedRef.current) replaceDraft(toDraft(profile));
  }, [profiles, replaceDraft, selectedId, userEditedRef]);

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
  const { discardGuard, requestDiscard } = useLaunchProfileUnsavedChanges({
    activeTool,
    initialRuntime,
    profiles,
    selectedId,
    toolDefaultProfile,
    draft,
    userEdited: userEditedRef.current,
    translate: t,
    onDirtyChange,
  });
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
      replaceDraft((current) => toolDefaultProfile ? toDraft(toolDefaultProfile) : systemDefaultLaunchProfileDraft(activeTool, current.targetRuntime ?? null, t));
    }
  }, [activeTool, filteredProfiles, replaceDraft, selectedId, toolDefaultProfile]);

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
    replaceDraft(systemDefaultLaunchProfileDraft(nextTool, draft.targetRuntime ?? null, t));
    resetTransientState();
  }, [activeTool, draft.targetRuntime, onActiveToolChange, replaceDraft, resetTransientState]);

  // chips 上移后 CLI 切换来自父级：受控 tool 变化时走同一条切换路径（选中/草稿/瞬态一并重置）
  useEffect(() => {
    if (tool && tool !== activeTool) handleToolChange(tool);
  }, [tool, activeTool, handleToolChange]);

  const handleListModeChange = useCallback((mode: LaunchProfileListMode) => {
    setListMode(mode);
    if (mode === "profiles") {
      setWorkspaceFilterName(WORKSPACE_FILTER_ALL);
    }
  }, []);

  const {
    handleCopySystemDefault,
    handleSelect,
    handleSelectSystemDefault,
    handleSelectWorkspace,
    handleSelectWorkspaceProfile,
  } = useLaunchProfileNavigation({
    activeTool, draft, profiles, selectedId, toolDefaultProfile, translate: t, requestDiscard,
    resetTransientState, setSelectedId, setDraft: replaceDraft, setWorkspaceFilterName, setPreview,
    setMcpManagerOpen, setWorkspaceBindingOpen, setBindingWorkspaceName,
  });

  const handleSave = useCallback(async () => {
    try {
      if ((activeTool === "pi" || activeTool === "omp") && draft.targetRuntime === "ssh") {
        toast.error(t(activeTool === "pi" ? "piSshRuntimeUnsupported" : "ompSshRuntimeUnsupported"));
        return;
      }
      const alias = draft.alias?.trim() || draft.name?.trim() || t("profileDefaultName", { tool: toolLabel(activeTool, t) });
      const nextDraft = {
        ...draft,
        name: draft.name?.trim() || alias,
        alias,
        providerId: isSystemDefaultSelected ? null : draft.providerId,
        modelId: isSystemDefaultSelected || !draft.providerId ? null : draft.modelId,
        adapterOptions: activeTool === "pi"
          ? { ...(draft.adapterOptions ?? {}), piTransport: "pty" as const }
          : draft.adapterOptions ?? {},
        yoloMode: activeTool === "pi" || activeTool === "omp" ? false : draft.yoloMode,
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
        replaceDraft(toDraft(saved));
        toast.success(t("toast.systemDefaultSaved"));
        return;
      }

      if (!selectedProfile && workspaceContext) {
        await updateWorkspaceLaunchProfile(workspaceContext.name, saved.id);
      }
      setSelectedId(saved.id);
      replaceDraft(toDraft(saved));
      toast.success(workspaceContext && !selectedProfile
        ? t("toast.profileSavedBound", { name: workspaceContext.name })
        : t("toast.profileSaved"));
    } catch (error) {
      toast.error(t("common:saveFailed", { error: String(error) }));
    }
  }, [activeTool, createProfile, draft, isSystemDefaultSelected, replaceDraft, selectedProfile, t, toolDefaultProfile, updateProfile, updateWorkspaceLaunchProfile, workspaceContext]);

  const deleteSelectedProfile = useCallback(async () => {
    if (!selectedProfile || isSystemDefaultSelected) return;
    try {
      for (const workspace of workspaces.filter((item) => item.launchProfileId === selectedProfile.id)) {
        await updateWorkspaceLaunchProfile(workspace.name, null);
      }
      await removeProfile(selectedProfile.id);
      setSelectedId(SYSTEM_DEFAULT_PROFILE_ID);
      replaceDraft((current) => toolDefaultProfile ? toDraft(toolDefaultProfile) : systemDefaultLaunchProfileDraft(activeTool, current.targetRuntime ?? null, t));
      toast.success(t("toast.profileDeleted"));
    } catch (error) {
      toast.error(t("common:deleteFailed", { error: String(error) }));
    }
  }, [activeTool, isSystemDefaultSelected, removeProfile, replaceDraft, selectedProfile, t, toolDefaultProfile, updateWorkspaceLaunchProfile, workspaces]);

  const handleDelete = useCallback(() => {
    if (!selectedProfile || isSystemDefaultSelected) return;
    requestDiscard(() => { void deleteSelectedProfile(); });
  }, [deleteSelectedProfile, isSystemDefaultSelected, requestDiscard, selectedProfile]);

  const setDefaultProfileAction = useCallback(async () => {
    if (!selectedProfile) return;
    replaceDraft(toDraft(selectedProfile));
    await setDefaultProfile(selectedProfile.id);
    toast.success(t("toast.defaultProfileUpdated"));
  }, [replaceDraft, selectedProfile, setDefaultProfile, t]);

  const handleSetDefault = useCallback(() => {
    if (!selectedProfile) return;
    requestDiscard(() => { void setDefaultProfileAction(); });
  }, [requestDiscard, selectedProfile, setDefaultProfileAction]);

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
    <>
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

        <main className="app-scrollbar min-h-0 flex-1 overflow-y-auto">
          <div className={`w-full space-y-2.5 ${compact ? "py-3" : "mx-auto max-w-5xl px-3 py-3"}`}>
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
              activeTool={activeTool}
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
    <UnsavedChangesDialog
      open={discardGuard.confirmOpen}
      onCancel={discardGuard.cancel}
      onDiscard={discardGuard.discard}
    />
    </>
  );
}
