/**
 * Short-drama pipeline entities mirroring `cc-panes-core/src/models/drama.rs`.
 * Shots reference durable media nodes/runs by loose ids; generation state is
 * always read from the media graph.
 */
export interface DramaProject {
  id: string;
  workspaceId: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface DramaEpisode {
  id: string;
  dramaId: string;
  ordinal: number;
  title: string;
  screenplay: string;
  createdAt: string;
  updatedAt: string;
}

export interface DramaShot {
  id: string;
  episodeId: string;
  ordinal: number;
  title: string;
  dialogue: string;
  prompt: string;
  imageNodeId?: string | null;
  imageRunId?: string | null;
  videoNodeId?: string | null;
  videoRunId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDramaProjectRequest {
  workspaceId: string;
  title: string;
  description?: string;
}

export interface UpdateDramaProjectRequest {
  title?: string;
  description?: string;
}

export interface CreateDramaEpisodeRequest {
  dramaId: string;
  title: string;
  ordinal?: number;
  screenplay?: string;
}

export interface UpdateDramaEpisodeRequest {
  title?: string;
  ordinal?: number;
  screenplay?: string;
}

export interface CreateDramaShotRequest {
  episodeId: string;
  ordinal?: number;
  title?: string;
  dialogue?: string;
  prompt?: string;
}

/** Reference fields: empty string clears, undefined keeps the current value. */
export interface UpdateDramaShotRequest {
  ordinal?: number;
  title?: string;
  dialogue?: string;
  prompt?: string;
  imageNodeId?: string;
  imageRunId?: string;
  videoNodeId?: string;
  videoRunId?: string;
}
