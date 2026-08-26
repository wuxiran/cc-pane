import { create } from "zustand";
import { persist } from "zustand/middleware";
import { generateId } from "@/lib/paneTree";
import type { MediaCanvasSpace } from "@/types/media";

interface CreateMediaCanvasSpaceInput {
  workspaceId: string;
  projectId?: string | null;
  name: string;
  /** Used only when adopting the project graph created before named spaces. */
  layoutId?: string;
}

interface EnsureProjectCanvasInput {
  workspaceId: string;
  projectId: string;
  name: string;
}

interface MediaCanvasState {
  spaces: MediaCanvasSpace[];
  activeSpaceIds: Record<string, string>;
  createSpace: (input: CreateMediaCanvasSpaceInput) => MediaCanvasSpace;
  ensureProjectSpace: (input: EnsureProjectCanvasInput) => MediaCanvasSpace;
  activateSpace: (spaceId: string) => void;
  renameSpace: (spaceId: string, name: string) => void;
  removeSpace: (spaceId: string) => void;
}

export function legacyMediaLayoutId(workspaceId: string, projectId: string): string {
  return `media-${workspaceId}-${projectId}`;
}

function createSpace(input: CreateMediaCanvasSpaceInput): MediaCanvasSpace {
  const id = generateId("media-canvas");
  const projectId = input.projectId ?? null;
  return {
    id,
    name: input.name.trim() || "Canvas",
    workspaceId: input.workspaceId,
    projectId,
    scope: projectId ? "project" : "workspace",
    layoutId: input.layoutId ?? `media-space-${id}`,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Named media Canvases are UI metadata, so they live alongside the existing
 * studio selection in local storage. The durable node/edge records continue
 * to be owned by the media service.
 */
export const useMediaCanvasStore = create<MediaCanvasState>()(
  persist(
    (set, get) => ({
      spaces: [],
      activeSpaceIds: {},
      createSpace: (input) => {
        const space = createSpace(input);
        set((state) => ({
          spaces: [...state.spaces, space],
          activeSpaceIds: { ...state.activeSpaceIds, [space.workspaceId]: space.id },
        }));
        return space;
      },
      ensureProjectSpace: ({ workspaceId, projectId, name }) => {
        const state = get();
        const active = state.spaces.find(
          (space) => state.activeSpaceIds[workspaceId] === space.id,
        );
        if (active?.workspaceId === workspaceId && (
          active.scope === "workspace" || active.projectId === projectId
        )) {
          return active;
        }

        const existing = state.spaces.find(
          (space) => space.workspaceId === workspaceId && space.projectId === projectId,
        );
        if (existing) {
          state.activateSpace(existing.id);
          return existing;
        }

        // Keep graphs made by the previous project-only studio visible after
        // the named-space migration instead of creating an empty replacement.
        return state.createSpace({
          workspaceId,
          projectId,
          name,
          layoutId: legacyMediaLayoutId(workspaceId, projectId),
        });
      },
      activateSpace: (spaceId) => set((state) => {
        const space = state.spaces.find((item) => item.id === spaceId);
        if (!space) return state;
        return {
          activeSpaceIds: { ...state.activeSpaceIds, [space.workspaceId]: space.id },
        };
      }),
      renameSpace: (spaceId, name) => {
        const nextName = name.trim();
        if (!nextName) return;
        set((state) => ({
          spaces: state.spaces.map((space) => (
            space.id === spaceId ? { ...space, name: nextName } : space
          )),
        }));
      },
      removeSpace: (spaceId) => set((state) => {
        const removed = state.spaces.find((space) => space.id === spaceId);
        if (!removed) return state;
        const activeSpaceIds = { ...state.activeSpaceIds };
        if (activeSpaceIds[removed.workspaceId] === spaceId) {
          delete activeSpaceIds[removed.workspaceId];
        }
        return {
          spaces: state.spaces.filter((space) => space.id !== spaceId),
          activeSpaceIds,
        };
      }),
    }),
    {
      name: "cc-panes-media-canvas-spaces",
      version: 1,
      partialize: (state) => ({
        spaces: state.spaces,
        activeSpaceIds: state.activeSpaceIds,
      }),
    },
  ),
);
