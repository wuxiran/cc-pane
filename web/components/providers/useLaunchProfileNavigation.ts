import { useCallback } from "react";
import { toastOk } from "@/lib/feedback";
import type { Dispatch, SetStateAction } from "react";
import type { LaunchProfile, LaunchProfileDraft, LaunchProfileResolution, Workspace } from "@/types";
import type { KnownCliTool } from "@/types/terminal";
import {
  SYSTEM_DEFAULT_PROFILE_ID,
  profileMatchesTool,
  type ProfilesT,
  systemDefaultLaunchProfileDraft,
  toDraft,
  toolLabel,
} from "./launchProfileHelpers";

interface UseLaunchProfileNavigationArgs {
  activeTool: KnownCliTool;
  draft: LaunchProfileDraft;
  profiles: LaunchProfile[];
  selectedId: string | null;
  toolDefaultProfile: LaunchProfile | null;
  translate: ProfilesT;
  requestDiscard: (action: () => void) => void;
  resetTransientState: () => void;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  setDraft: Dispatch<SetStateAction<LaunchProfileDraft>>;
  setWorkspaceFilterName: Dispatch<SetStateAction<string>>;
  setPreview: Dispatch<SetStateAction<LaunchProfileResolution | null>>;
  setMcpManagerOpen: Dispatch<SetStateAction<boolean>>;
  setWorkspaceBindingOpen: Dispatch<SetStateAction<boolean>>;
  setBindingWorkspaceName: Dispatch<SetStateAction<string | null>>;
}

export function useLaunchProfileNavigation({
  activeTool,
  draft,
  profiles,
  selectedId,
  toolDefaultProfile,
  translate: t,
  requestDiscard,
  resetTransientState,
  setSelectedId,
  setDraft,
  setWorkspaceFilterName,
  setPreview,
  setMcpManagerOpen,
  setWorkspaceBindingOpen,
  setBindingWorkspaceName,
}: UseLaunchProfileNavigationArgs) {
  const selectSystemDefault = useCallback(() => {
    setSelectedId(SYSTEM_DEFAULT_PROFILE_ID);
    setDraft((current) => toolDefaultProfile ? toDraft(toolDefaultProfile) : systemDefaultLaunchProfileDraft(activeTool, current.targetRuntime ?? null, t));
    resetTransientState();
  }, [activeTool, resetTransientState, t, toolDefaultProfile]);
  const handleSelectSystemDefault = useCallback(() => requestDiscard(selectSystemDefault), [requestDiscard, selectSystemDefault]);
  const selectProfile = useCallback((profile: LaunchProfile) => {
    setSelectedId(profile.id);
    setDraft(toDraft(profile));
    resetTransientState();
  }, [resetTransientState, setDraft, setSelectedId]);
  const handleSelect = useCallback((profile: LaunchProfile) => requestDiscard(() => selectProfile(profile)), [requestDiscard, selectProfile]);

  const handleSelectWorkspace = useCallback((workspace: Workspace) => {
    const boundProfile = workspace.launchProfileId
      ? profiles.find((profile) => profile.id === workspace.launchProfileId && profileMatchesTool(profile, activeTool)) ?? null
      : null;
    requestDiscard(() => {
      setWorkspaceFilterName(workspace.name);
      if (boundProfile) selectProfile(boundProfile);
      else selectSystemDefault();
    });
  }, [activeTool, profiles, requestDiscard, selectProfile, selectSystemDefault, setWorkspaceFilterName]);
  const handleSelectWorkspaceProfile = useCallback((workspace: Workspace, profile: LaunchProfile) => requestDiscard(() => {
    setWorkspaceFilterName(workspace.name);
    selectProfile(profile);
  }), [requestDiscard, selectProfile, setWorkspaceFilterName]);

  const copySystemDefault = useCallback(() => {
    const base = selectedId === SYSTEM_DEFAULT_PROFILE_ID ? draft : systemDefaultLaunchProfileDraft(activeTool, draft.targetRuntime ?? null, t);
    const name = t("profileDefaultName", { tool: toolLabel(activeTool, t) });
    setSelectedId(null);
    setDraft({ ...base, name, alias: name, targetTools: [activeTool], targetRuntime: draft.targetRuntime ?? null, isDefault: false });
    setPreview(null);
    setMcpManagerOpen(false);
    setWorkspaceBindingOpen(false);
    setBindingWorkspaceName(null);
    toastOk(t("toast.draftCreated", { tool: toolLabel(activeTool, t) }));
  }, [activeTool, draft, selectedId, setBindingWorkspaceName, setDraft, setMcpManagerOpen, setPreview, setSelectedId, setWorkspaceBindingOpen, t]);
  const handleCopySystemDefault = useCallback(() => requestDiscard(copySystemDefault), [copySystemDefault, requestDiscard]);

  return {
    handleCopySystemDefault,
    handleSelect,
    handleSelectSystemDefault,
    handleSelectWorkspace,
    handleSelectWorkspaceProfile,
  };
}
