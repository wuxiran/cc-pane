import { useCallback, useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { useTranslation } from "react-i18next";
import { useLaunchProfilesStore, useProvidersStore, useSharedMcpStore, useWorkspacesStore } from "@/stores";
import type { LaunchProfileDraft, LaunchProfileResolution, LaunchProfileRuntime } from "@/types";
import { useCliTools } from "@/hooks/useCliTools";
import { isProviderTypeCompatibleWithCli } from "@/utils/providerCompatibility";
import type { KnownCliTool } from "@/types/terminal";
import LaunchProfileBasicsCard from "./LaunchProfileBasicsCard";
import LaunchProfileRow, { LaunchProfileAddRow, useProfileRowSummary } from "./LaunchProfileRow";
import LaunchProfileListAside, {
  type LaunchProfileListMode,
} from "./LaunchProfileListAside";
import LaunchProfileMcpCard from "./LaunchProfileMcpCard";
import LaunchProfileNativeConfigCard from "./LaunchProfileNativeConfigCard";
import LaunchProfileSkillCard from "./LaunchProfileSkillCard";
import LaunchProfileSummaryCard from "./LaunchProfileSummaryCard";
import UnsavedChangesDialog from "./UnsavedChangesDialog";
import ProviderImportDialog from "./ProviderImportDialog";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import type { ExternalProviderSource } from "@/types/provider";
import { useLaunchProfileUnsavedChanges } from "./useLaunchProfileUnsavedChanges";
import { useLaunchProfileNavigation } from "./useLaunchProfileNavigation";
import { useLaunchProfileDraft } from "./useLaunchProfileDraft";
import { useExternalSkills } from "./useExternalSkills";
import { useLaunchProfileSkillEditor } from "./useLaunchProfileSkillEditor";
import { useLaunchProfileActions } from "./useLaunchProfileActions";
import {
  SYSTEM_DEFAULT_PROFILE_ID,
  WORKSPACE_FILTER_ALL,
  draftDisplayName,
  profileDisplayName,
  profileMatchesTool,
  systemDefaultLaunchProfileDraft,
  toDraft,
  toolLabel,
  workspaceProfileIds,
  type ExternalSkillSourceKind,
} from "./launchProfileHelpers";
import {
  nextMcpMode,
  nextSkillMode,
  nextToggleExternalSource,
  nextToggleProfileSkill,
} from "./launchProfileSkillPolicy";
interface LaunchProfilesPanelProps {
  compact?: boolean;
  initialTool?: KnownCliTool;
  /** 受控 CLI（chips 已上移到 ProviderPagesHeader，由父级切换后经此同步进来） */
  tool?: KnownCliTool;
  /** 当前上下文（活动终端 / 工作空间）推断的运行位置：只用于解析预览，配置本身不区分运行位置 */
  initialRuntime?: LaunchProfileRuntime;
  onActiveToolChange?: (tool: KnownCliTool) => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** 凭证行「管理凭证」：跳到供应商凭证页（凭证页不再作为顶部标签常驻） */
  onManageCredentials?: () => void;
  /** 左栏工作空间视角，默认隐藏 */
  showWorkspaceLens?: boolean;
}

export default function LaunchProfilesPanel({
  compact,
  initialTool,
  tool,
  initialRuntime = null,
  onActiveToolChange,
  onDirtyChange,
  onManageCredentials,
  showWorkspaceLens = false,
}: LaunchProfilesPanelProps) {
  const { tools: cliTools } = useCliTools();
  const { t } = useTranslation(["providers", "common"]);
  const profiles = useLaunchProfilesStore((s) => s.profiles);
  const loadProfiles = useLaunchProfilesStore((s) => s.load);
  const previewProfile = useLaunchProfilesStore((s) => s.preview);
  const providers = useProvidersStore((s) => s.providers);
  const loadProviders = useProvidersStore((s) => s.loadProviders);
  const servers = useSharedMcpStore((s) => s.servers);
  const fetchMcpStatus = useSharedMcpStore((s) => s.fetchStatus);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const workspacesLoading = useWorkspacesStore((s) => s.loading);
  const loadWorkspaces = useWorkspacesStore((s) => s.load);

  const resolvedInitialTool = tool ?? initialTool ?? "claude";
  const [activeTool, setActiveTool] = useState<KnownCliTool>(resolvedInitialTool);
  const [selectedId, setSelectedId] = useState<string | null>(SYSTEM_DEFAULT_PROFILE_ID);
  const { draft, setDraft, replaceDraft, userEditedRef } = useLaunchProfileDraft(() => systemDefaultLaunchProfileDraft(resolvedInitialTool, t));
  const [preview, setPreview] = useState<LaunchProfileResolution | null>(null);
  const [workspaceBindingOpen, setWorkspaceBindingOpen] = useState(false);
  const [bindingWorkspaceName, setBindingWorkspaceName] = useState<string | null>(null);
  const [workspaceFilterName, setWorkspaceFilterName] = useState(WORKSPACE_FILTER_ALL);
  const [listMode, setListMode] = useState<LaunchProfileListMode>("profiles");
  const [importSource, setImportSource] = useState<ExternalProviderSource | null>(null);
  const externalSkills = useExternalSkills();
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
      replaceDraft(toolDefaultProfile ? toDraft(toolDefaultProfile) : systemDefaultLaunchProfileDraft(activeTool, t));
    }
  }, [activeTool, profiles, replaceDraft, selectedId, toolDefaultProfile]);

  useEffect(() => {
    if (selectedId === SYSTEM_DEFAULT_PROFILE_ID && !(toolDefaultProfile && userEditedRef.current)) {
      replaceDraft(toolDefaultProfile ? toDraft(toolDefaultProfile) : systemDefaultLaunchProfileDraft(activeTool, t));
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
            runtimeKind: initialRuntime ?? null,
          }
        : {
          useSystemDefault: true,
          workspaceName: workspaceContext?.name ?? null,
          providerSelection: "none" as const,
          cliTool: activeTool,
          runtimeKind: initialRuntime ?? null,
        }
      : {
          profileId: selectedId,
          workspaceName: workspaceContext?.name ?? null,
          cliTool: activeTool,
          runtimeKind: initialRuntime ?? null,
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
  }, [activeTool, initialRuntime, previewProfile, profiles, selectedId, toolDefaultProfile, workspaceContext?.name]);

  const selectedProfile = useMemo(
    () => selectedId === SYSTEM_DEFAULT_PROFILE_ID
      ? toolDefaultProfile
      : profiles.find((profile) => profile.id === selectedId) ?? null,
    [profiles, selectedId, toolDefaultProfile],
  );
  const { discardGuard, requestDiscard, isDirty } = useLaunchProfileUnsavedChanges({
    activeTool,
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
      replaceDraft(toolDefaultProfile ? toDraft(toolDefaultProfile) : systemDefaultLaunchProfileDraft(activeTool, t));
    }
  }, [activeTool, filteredProfiles, replaceDraft, selectedId, toolDefaultProfile]);

  const resetTransientState = useCallback(() => {
    setPreview(null);
    setWorkspaceBindingOpen(false);
    setBindingWorkspaceName(null);
    cancelProfileSkillEdit();
  }, [cancelProfileSkillEdit]);

  const handleToolChange = useCallback((nextTool: KnownCliTool) => {
    if (nextTool === activeTool) return;
    setActiveTool(nextTool);
    onActiveToolChange?.(nextTool);
    setSelectedId(SYSTEM_DEFAULT_PROFILE_ID);
    replaceDraft(systemDefaultLaunchProfileDraft(nextTool, t));
    resetTransientState();
  }, [activeTool, onActiveToolChange, replaceDraft, resetTransientState]);

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
    setWorkspaceBindingOpen, setBindingWorkspaceName,
  });

  const { handleSave, handleDelete, handleSetDefault, handleToggleWorkspaceBinding } = useLaunchProfileActions({
    activeTool, draft, isSystemDefaultSelected, selectedDraftProvider, selectedProfile, selectedProfileId,
    toolDefaultProfile, workspaceContext, workspaces, translate: t, requestDiscard, replaceDraft,
    setSelectedId, setBindingWorkspaceName,
  });

  const setMcpMode = (mode: LaunchProfileDraft["mcpPolicy"]["mode"]) => {
    setDraft((current) => nextMcpMode(current, mode, servers));
  };
  const setSkillMode = (mode: LaunchProfileDraft["skillPolicy"]["mode"]) => {
    setDraft((current) => nextSkillMode(current, mode, externalSkills));
  };
  const toggleProfileSkill = (id: string) => {
    setDraft((current) => nextToggleProfileSkill(current, id));
  };
  const toggleExternalSource = (kind: ExternalSkillSourceKind, included: boolean) => {
    setDraft((current) => nextToggleExternalSource(current, kind, included));
  };

  // 列表：系统默认 + 已保存 + 新建中的草稿；只有选中的那一行展开，其余收成一行摘要
  const [expanded, setExpanded] = useState(true);
  useEffect(() => { setExpanded(true); }, [selectedId]);
  const rowSummary = useProfileRowSummary(providers, activeTool);
  const rows = useMemo(() => {
    const systemSource = toolDefaultProfile ? toDraft(toolDefaultProfile) : systemDefaultLaunchProfileDraft(activeTool, t);
    return [
      {
        key: SYSTEM_DEFAULT_PROFILE_ID,
        label: t("systemDefaultShort"),
        isDefault: false,
        active: selectedId === SYSTEM_DEFAULT_PROFILE_ID,
        source: selectedId === SYSTEM_DEFAULT_PROFILE_ID ? draft : systemSource,
        onSelect: handleSelectSystemDefault,
      },
      ...profilesForActiveTool.map((profile) => ({
        key: profile.id,
        label: profileDisplayName(profile),
        isDefault: profile.isDefault,
        active: selectedId === profile.id,
        source: selectedId === profile.id ? draft : toDraft(profile),
        onSelect: () => handleSelect(profile),
      })),
      ...(selectedId === null ? [{
        key: "new-draft",
        label: `${draftDisplayName(draft, t)} · ${t("profileRowNew")}`,
        isDefault: false,
        active: true,
        source: draft,
        onSelect: () => {},
      }] : []),
    ];
  }, [activeTool, draft, handleSelect, handleSelectSystemDefault, profilesForActiveTool, selectedId, t, toolDefaultProfile]);

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
          profiles={profiles}
          filteredProfiles={profilesForActiveTool}
          selectedId={selectedId}
          onCopySystemDefault={handleCopySystemDefault}
          onSelectSystemDefault={handleSelectSystemDefault}
          onSelect={handleSelect}
          onSelectWorkspaceProfile={handleSelectWorkspaceProfile}
          onSelectWorkspace={handleSelectWorkspace}
          // 受控时交给父级（它持有未保存守卫，再经 tool prop 回流）；独立使用时自己守卫
          showWorkspaceLens={showWorkspaceLens}
          onSelectTool={(nextTool) => (onActiveToolChange
            ? onActiveToolChange(nextTool)
            : requestDiscard(() => handleToolChange(nextTool)))}
        />

        <main className="app-scrollbar min-h-0 flex-1 overflow-y-auto">
          <div className={`w-full space-y-2.5 ${compact ? "pb-3" : "max-w-[1200px] px-4 pb-4"}`}>
            {/* 列表顶部：从外部工具导入中转站（预览 → 勾选 → 一次导入），导入后直接出现在凭证的「中转站」里 */}
            {!compact && (
              <div className="flex items-center justify-end gap-1.5 pt-1">
                {(["cc_switch", "magpie"] as const).map((source) => (
                  <Button key={source} size="xs" variant="outline" onClick={() => setImportSource(source)}>
                    <Download size={13} /> {t(`importFromSource.${source}`)}
                  </Button>
                ))}
              </div>
            )}
            {/* 展开的那一行：行头（标题+动作）与基础 / MCP / Skill 同在一张卡里，分隔线隔开 */}
            <div aria-label={t("profileList")} className="space-y-2">
            {rows.map((row) => (row.active && (expanded || compact) ? (
            <Card key={row.key} data-testid="launch-profile-expanded" className="divide-y divide-[var(--app-border)]/60">
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
              onCollapse={compact ? undefined : () => setExpanded(false)}
              onRename={isSystemDefaultSelected ? undefined : (name) => setDraft((current) => ({ ...current, alias: name, name }))}
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
              onManageCredentials={onManageCredentials}
            />

            <LaunchProfileMcpCard
              draft={draft}
              setDraft={setDraft}
              activeTool={activeTool}
              setMcpMode={setMcpMode}
              effective={preview ? preview.mcpServers.filter((server) => server.enabled) : null}
              effectiveStale={isDirty}
            />

            <LaunchProfileSkillCard
              draft={draft}
              setDraft={setDraft}
              activeTool={activeTool}
              setSkillMode={setSkillMode}
              toggleExternalSource={toggleExternalSource}
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
              effective={preview ? preview.skills.filter((skill) => skill.enabled) : null}
              effectiveStale={isDirty}
            />
            <LaunchProfileNativeConfigCard draft={draft} setDraft={setDraft} activeTool={activeTool} />
            </Card>
            ) : compact ? null : (
              <LaunchProfileRow
                key={row.key}
                label={row.label}
                summary={rowSummary(row.source)}
                isDefault={row.isDefault}
                current={row.active}
                onClick={row.active ? () => setExpanded(true) : row.onSelect}
              />
            )))}
            {!compact && <LaunchProfileAddRow onClick={handleCopySystemDefault} />}
            </div>
          </div>
        </main>
      </div>
    </div>
    <ProviderImportDialog source={importSource} onClose={() => setImportSource(null)} />
    <UnsavedChangesDialog
      open={discardGuard.confirmOpen}
      onCancel={discardGuard.cancel}
      onDiscard={discardGuard.discard}
    />
    </>
  );
}
