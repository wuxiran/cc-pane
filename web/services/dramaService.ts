import type {
  CreateDramaEpisodeRequest,
  CreateDramaProjectRequest,
  CreateDramaShotRequest,
  DramaEpisode,
  DramaProject,
  DramaShot,
  UpdateDramaEpisodeRequest,
  UpdateDramaProjectRequest,
  UpdateDramaShotRequest,
} from "@/types/drama";
import { apiDelete, apiGet, apiJson, invokeOrApi } from "./apiClient";

/** CRUD facade for the short-drama pipeline (Tauri invoke / REST). */
export const dramaService = {
  createProject(request: CreateDramaProjectRequest): Promise<DramaProject> {
    return invokeOrApi("create_drama_project", { request }, () => apiJson("/api/drama/projects", "POST", request));
  },

  listProjects(workspaceId: string): Promise<DramaProject[]> {
    return invokeOrApi("list_drama_projects", { workspaceId }, () => apiGet("/api/drama/projects", { workspaceId }));
  },

  updateProject(dramaId: string, request: UpdateDramaProjectRequest): Promise<DramaProject> {
    return invokeOrApi("update_drama_project", { dramaId, request }, () => apiJson(`/api/drama/projects/${dramaId}`, "PUT", request));
  },

  deleteProject(dramaId: string): Promise<boolean> {
    return invokeOrApi("delete_drama_project", { dramaId }, async () => {
      await apiDelete(`/api/drama/projects/${dramaId}`);
      return true;
    });
  },

  createEpisode(request: CreateDramaEpisodeRequest): Promise<DramaEpisode> {
    return invokeOrApi("create_drama_episode", { request }, () => apiJson("/api/drama/episodes", "POST", request));
  },

  listEpisodes(dramaId: string): Promise<DramaEpisode[]> {
    return invokeOrApi("list_drama_episodes", { dramaId }, () => apiGet("/api/drama/episodes", { dramaId }));
  },

  updateEpisode(episodeId: string, request: UpdateDramaEpisodeRequest): Promise<DramaEpisode> {
    return invokeOrApi("update_drama_episode", { episodeId, request }, () => apiJson(`/api/drama/episodes/${episodeId}`, "PUT", request));
  },

  deleteEpisode(episodeId: string): Promise<boolean> {
    return invokeOrApi("delete_drama_episode", { episodeId }, async () => {
      await apiDelete(`/api/drama/episodes/${episodeId}`);
      return true;
    });
  },

  createShot(request: CreateDramaShotRequest): Promise<DramaShot> {
    return invokeOrApi("create_drama_shot", { request }, () => apiJson("/api/drama/shots", "POST", request));
  },

  listShots(episodeId: string): Promise<DramaShot[]> {
    return invokeOrApi("list_drama_shots", { episodeId }, () => apiGet("/api/drama/shots", { episodeId }));
  },

  updateShot(shotId: string, request: UpdateDramaShotRequest): Promise<DramaShot> {
    return invokeOrApi("update_drama_shot", { shotId, request }, () => apiJson(`/api/drama/shots/${shotId}`, "PUT", request));
  },

  deleteShot(shotId: string): Promise<boolean> {
    return invokeOrApi("delete_drama_shot", { shotId }, async () => {
      await apiDelete(`/api/drama/shots/${shotId}`);
      return true;
    });
  },
};
