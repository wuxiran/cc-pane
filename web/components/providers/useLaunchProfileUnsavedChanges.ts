import { useCallback, useEffect, useMemo, useRef } from "react";
import type { LaunchProfile, LaunchProfileDraft, LaunchProfileRuntime } from "@/types";
import type { KnownCliTool } from "@/types/terminal";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import {
  SYSTEM_DEFAULT_PROFILE_ID,
  systemDefaultLaunchProfileDraft,
  toDraft,
} from "./launchProfileHelpers";

interface UseLaunchProfileUnsavedChangesArgs {
  activeTool: KnownCliTool;
  initialRuntime: LaunchProfileRuntime;
  profiles: LaunchProfile[];
  selectedId: string | null;
  toolDefaultProfile: LaunchProfile | null;
  draft: LaunchProfileDraft;
  userEdited: boolean;
  translate: import("./launchProfileHelpers").ProfilesT;
  onDirtyChange?: (dirty: boolean) => void;
}

export function useLaunchProfileUnsavedChanges({
  activeTool,
  initialRuntime,
  profiles,
  selectedId,
  toolDefaultProfile,
  draft,
  userEdited,
  translate,
  onDirtyChange,
}: UseLaunchProfileUnsavedChangesArgs) {
  const defaultDraftKey = `${activeTool}:${toolDefaultProfile?.id ?? "system"}`;
  const previousDefaultDraftKeyRef = useRef(defaultDraftKey);
  const defaultDraftHydrating = !userEdited && selectedId === SYSTEM_DEFAULT_PROFILE_ID
    && previousDefaultDraftKeyRef.current !== defaultDraftKey;

  useEffect(() => {
    previousDefaultDraftKeyRef.current = defaultDraftKey;
  }, [defaultDraftKey]);

  const savedDraft = useMemo(() => {
    if (selectedId === SYSTEM_DEFAULT_PROFILE_ID) {
      return toolDefaultProfile
        ? toDraft(toolDefaultProfile)
        : systemDefaultLaunchProfileDraft(activeTool, initialRuntime, translate);
    }
    if (selectedId === null) return null;
    const profile = profiles.find((item) => item.id === selectedId);
    return profile ? toDraft(profile) : null;
  }, [activeTool, initialRuntime, profiles, selectedId, toolDefaultProfile, translate]);

  const isDirty = !defaultDraftHydrating && (
    selectedId === null
    || savedDraft === null
    || JSON.stringify(draft) !== JSON.stringify(savedDraft)
  );
  const discardGuard = useUnsavedChangesGuard(isDirty, () => onDirtyChange?.(false));

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const requestDiscard = useCallback((action: () => void) => {
    discardGuard.request(action);
  }, [discardGuard.request]);

  return { discardGuard, requestDiscard };
}
