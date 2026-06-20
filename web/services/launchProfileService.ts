import { apiDelete, apiGet, apiJson, apiNoContent, invokeOrApi } from "./apiClient";
import type {
  LaunchProfile,
  LaunchProfileDraft,
  LaunchProfilePreviewRequest,
  LaunchProfileResolution,
} from "@/types";

export const launchProfileService = {
  list(): Promise<LaunchProfile[]> {
    return invokeOrApi<LaunchProfile[]>("list_launch_profiles", undefined, () =>
      apiGet<LaunchProfile[]>("/api/launch-profiles"),
    );
  },

  get(id: string): Promise<LaunchProfile | null> {
    return invokeOrApi<LaunchProfile | null>("get_launch_profile", { id }, () =>
      apiGet<LaunchProfile | null>(`/api/launch-profiles/${encodeURIComponent(id)}`),
    );
  },

  create(draft: LaunchProfileDraft): Promise<LaunchProfile> {
    return invokeOrApi<LaunchProfile>("create_launch_profile", { draft }, () =>
      apiJson<LaunchProfile>("/api/launch-profiles", "POST", draft),
    );
  },

  update(id: string, draft: LaunchProfileDraft): Promise<LaunchProfile> {
    return invokeOrApi<LaunchProfile>("update_launch_profile", { id, draft }, () =>
      apiJson<LaunchProfile>(`/api/launch-profiles/${encodeURIComponent(id)}`, "PUT", draft),
    );
  },

  remove(id: string): Promise<void> {
    return invokeOrApi<void>("delete_launch_profile", { id }, () =>
      apiDelete(`/api/launch-profiles/${encodeURIComponent(id)}`),
    );
  },

  setDefault(id: string): Promise<void> {
    return invokeOrApi<void>("set_default_launch_profile", { id }, () =>
      apiNoContent(`/api/launch-profiles/${encodeURIComponent(id)}/default`, {
        method: "POST",
      }),
    );
  },

  preview(request: LaunchProfilePreviewRequest): Promise<LaunchProfileResolution> {
    return invokeOrApi<LaunchProfileResolution>(
      "preview_launch_profile_resolution",
      { request },
      () =>
        apiJson<LaunchProfileResolution>(
          "/api/launch-profiles/preview",
          "POST",
          request,
        ),
    );
  },
};
