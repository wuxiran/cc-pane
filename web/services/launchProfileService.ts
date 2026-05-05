import { invoke } from "@tauri-apps/api/core";
import type {
  LaunchProfile,
  LaunchProfileDraft,
  LaunchProfilePreviewRequest,
  LaunchProfileResolution,
} from "@/types";

export const launchProfileService = {
  list(): Promise<LaunchProfile[]> {
    return invoke<LaunchProfile[]>("list_launch_profiles");
  },

  get(id: string): Promise<LaunchProfile | null> {
    return invoke<LaunchProfile | null>("get_launch_profile", { id });
  },

  create(draft: LaunchProfileDraft): Promise<LaunchProfile> {
    return invoke<LaunchProfile>("create_launch_profile", { draft });
  },

  update(id: string, draft: LaunchProfileDraft): Promise<LaunchProfile> {
    return invoke<LaunchProfile>("update_launch_profile", { id, draft });
  },

  remove(id: string): Promise<void> {
    return invoke("delete_launch_profile", { id });
  },

  setDefault(id: string): Promise<void> {
    return invoke("set_default_launch_profile", { id });
  },

  preview(request: LaunchProfilePreviewRequest): Promise<LaunchProfileResolution> {
    return invoke<LaunchProfileResolution>("preview_launch_profile_resolution", { request });
  },
};
