// 运行配置的写操作（保存 / 删除 / 设为默认 / 绑定工作空间）。
// 从 LaunchProfilesPanel 拆出：面板只负责选中态与渲染，持久化与提示文案集中在这里。
import { useCallback, type Dispatch, type SetStateAction } from "react";
import { toastErr, toastInfo, toastOk } from "@/lib/feedback";
import { useLaunchProfilesStore, useWorkspacesStore } from "@/stores";
import type { LaunchProfile, LaunchProfileDraft, Provider, Workspace } from "@/types";
import type { KnownCliTool } from "@/types/terminal";
import { isLocalWslOnlyCliTool } from "@/utils/cliTool";
import { profileProviderFields } from "./launchProfileAccounts";
import {
  SYSTEM_DEFAULT_PROFILE_ID,
  type ProfilesT,
  systemDefaultLaunchProfileDraft,
  toDraft,
  toolLabel,
} from "./launchProfileHelpers";

interface UseLaunchProfileActionsArgs {
  activeTool: KnownCliTool;
  draft: LaunchProfileDraft;
  isSystemDefaultSelected: boolean;
  selectedDraftProvider: Provider | undefined;
  selectedProfile: LaunchProfile | null;
  selectedProfileId: string | null;
  toolDefaultProfile: LaunchProfile | null;
  workspaceContext: Workspace | null;
  workspaces: Workspace[];
  translate: ProfilesT;
  requestDiscard: (action: () => void) => void;
  replaceDraft: Dispatch<SetStateAction<LaunchProfileDraft>>;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  setBindingWorkspaceName: Dispatch<SetStateAction<string | null>>;
}

export function useLaunchProfileActions({
  activeTool,
  draft,
  isSystemDefaultSelected,
  selectedDraftProvider,
  selectedProfile,
  selectedProfileId,
  toolDefaultProfile,
  workspaceContext,
  workspaces,
  translate: t,
  requestDiscard,
  replaceDraft,
  setSelectedId,
  setBindingWorkspaceName,
}: UseLaunchProfileActionsArgs) {
  const createProfile = useLaunchProfilesStore((s) => s.create);
  const updateProfile = useLaunchProfilesStore((s) => s.update);
  const removeProfile = useLaunchProfilesStore((s) => s.remove);
  const setDefaultProfile = useLaunchProfilesStore((s) => s.setDefault);
  const updateWorkspaceLaunchProfile = useWorkspacesStore((s) => s.updateWorkspaceLaunchProfile);

  const handleSave = useCallback(async () => {
    try {
      const alias = draft.alias?.trim() || draft.name?.trim() || t("profileDefaultName", { tool: toolLabel(activeTool, t) });
      const nextDraft = {
        ...draft,
        name: draft.name?.trim() || alias,
        alias,
        ...profileProviderFields(draft, isSystemDefaultSelected, selectedDraftProvider, activeTool),
        adapterOptions: activeTool === "pi"
          ? { ...(draft.adapterOptions ?? {}), piTransport: "pty" as const }
          : draft.adapterOptions ?? {},
        yoloMode: isLocalWslOnlyCliTool(activeTool) ? false : draft.yoloMode,
        isDefault: isSystemDefaultSelected ? true : draft.isDefault,
        targetTools: [activeTool],
        // 已弃用：运行配置本机 / WSL / SSH 通用，后端忽略该字段并恒存 null
        targetRuntime: null,
      };
      const profileToUpdate = isSystemDefaultSelected ? toolDefaultProfile : selectedProfile;
      const saved = profileToUpdate
        ? await updateProfile(profileToUpdate.id, nextDraft)
        : await createProfile(nextDraft);
      if (isSystemDefaultSelected) {
        setSelectedId(SYSTEM_DEFAULT_PROFILE_ID);
        replaceDraft(toDraft(saved));
        toastOk(t("toast.systemDefaultSaved"));
        return;
      }

      if (!selectedProfile && workspaceContext) {
        await updateWorkspaceLaunchProfile(workspaceContext.name, saved.id);
      }
      setSelectedId(saved.id);
      replaceDraft(toDraft(saved));
      toastOk(workspaceContext && !selectedProfile
        ? t("toast.profileSavedBound", { name: workspaceContext.name })
        : t("toast.profileSaved"));
    } catch (error) {
      toastErr(t("common:saveFailed", { error: String(error) }));
    }
  }, [activeTool, createProfile, draft, isSystemDefaultSelected, replaceDraft, selectedDraftProvider, selectedProfile, setSelectedId, t, toolDefaultProfile, updateProfile, updateWorkspaceLaunchProfile, workspaceContext]);

  const deleteSelectedProfile = useCallback(async () => {
    if (!selectedProfile || isSystemDefaultSelected) return;
    try {
      for (const workspace of workspaces.filter((item) => item.launchProfileId === selectedProfile.id)) {
        await updateWorkspaceLaunchProfile(workspace.name, null);
      }
      await removeProfile(selectedProfile.id);
      setSelectedId(SYSTEM_DEFAULT_PROFILE_ID);
      replaceDraft(toolDefaultProfile ? toDraft(toolDefaultProfile) : systemDefaultLaunchProfileDraft(activeTool, t));
      toastOk(t("toast.profileDeleted"));
    } catch (error) {
      toastErr(t("common:deleteFailed", { error: String(error) }));
    }
  }, [activeTool, isSystemDefaultSelected, removeProfile, replaceDraft, selectedProfile, setSelectedId, t, toolDefaultProfile, updateWorkspaceLaunchProfile, workspaces]);

  const handleDelete = useCallback(() => {
    if (!selectedProfile || isSystemDefaultSelected) return;
    requestDiscard(() => { void deleteSelectedProfile(); });
  }, [deleteSelectedProfile, isSystemDefaultSelected, requestDiscard, selectedProfile]);

  const setDefaultProfileAction = useCallback(async () => {
    if (!selectedProfile) return;
    replaceDraft(toDraft(selectedProfile));
    await setDefaultProfile(selectedProfile.id);
    toastOk(t("toast.defaultProfileUpdated"));
  }, [replaceDraft, selectedProfile, setDefaultProfile, t]);

  const handleSetDefault = useCallback(() => {
    if (!selectedProfile) return;
    requestDiscard(() => { void setDefaultProfileAction(); });
  }, [requestDiscard, selectedProfile, setDefaultProfileAction]);

  const handleToggleWorkspaceBinding = useCallback(async (workspaceName: string, checked: boolean) => {
    if (!selectedProfileId) {
      toastInfo(t("toast.saveProfileFirst"));
      return;
    }
    setBindingWorkspaceName(workspaceName);
    try {
      await updateWorkspaceLaunchProfile(workspaceName, checked ? selectedProfileId : null);
      toastOk(checked ? t("toast.boundTo", { name: workspaceName }) : t("toast.unboundFrom", { name: workspaceName }));
    } catch (error) {
      toastErr(t("toast.workspaceBindFailed", { error: String(error) }));
    } finally {
      setBindingWorkspaceName(null);
    }
  }, [selectedProfileId, setBindingWorkspaceName, t, updateWorkspaceLaunchProfile]);

  return { handleSave, handleDelete, handleSetDefault, handleToggleWorkspaceBinding };
}
