import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { MediaProtocol } from "@/types/media";

export type MediaStudioKind = "image" | "video";

export interface MediaStudioSelection {
  workspaceId: string | null;
  projectId: string | null;
  providerId: string | null;
  modelId: string | null;
  protocol: MediaProtocol;
}

interface MediaStudioState {
  selections: Record<MediaStudioKind, MediaStudioSelection>;
  setSelection: (kind: MediaStudioKind, patch: Partial<MediaStudioSelection>) => void;
  resetSelection: (kind: MediaStudioKind) => void;
}

const emptySelection = (): MediaStudioSelection => ({
  workspaceId: null,
  projectId: null,
  providerId: null,
  modelId: null,
  protocol: "open_ai_compatible",
});

export const useMediaStudioStore = create<MediaStudioState>()(
  persist(
    (set) => ({
      selections: {
        image: emptySelection(),
        video: emptySelection(),
      },
      setSelection: (kind, patch) => set((state) => {
        const current = state.selections[kind];
        const next = { ...current, ...patch };
        const scopeChanged = Object.prototype.hasOwnProperty.call(patch, "workspaceId")
          || Object.prototype.hasOwnProperty.call(patch, "projectId");

        // Workspace/project is the media root scope, not a per-mode setting.
        // Provider routing remains mode-specific so image and video can use
        // different cloud endpoints while sharing one project graph.
        if (!scopeChanged) {
          return { selections: { ...state.selections, [kind]: next } };
        }
        const scopePatch = {
          workspaceId: next.workspaceId,
          projectId: next.projectId,
        };
        return {
          selections: {
            ...state.selections,
            image: { ...state.selections.image, ...scopePatch },
            video: { ...state.selections.video, ...scopePatch },
            [kind]: next,
          },
        };
      }),
      resetSelection: (kind) => set((state) => {
        const current = state.selections[kind];
        // Reset provider-specific controls without detaching the shared
        // workspace/project root selected for the media workspace.
        return {
          selections: {
            ...state.selections,
            [kind]: {
              ...emptySelection(),
              workspaceId: current.workspaceId,
              projectId: current.projectId,
            },
          },
        };
      }),
    }),
    {
      name: "cc-panes-media-studio",
      version: 2,
      // API keys are deliberately excluded. ProviderService remains the only
      // persistence boundary for credentials.
      partialize: (state) => ({
        selections: Object.fromEntries(
          (Object.entries(state.selections) as Array<[MediaStudioKind, MediaStudioSelection]>).map(([kind, selection]) => [
            kind,
            { workspaceId: selection.workspaceId, projectId: selection.projectId, providerId: selection.providerId, modelId: selection.modelId, protocol: selection.protocol },
          ]),
        ),
      }),
      migrate: (persistedState) => {
        const persisted = persistedState as Partial<MediaStudioState> | undefined;
        const persistedSelections = persisted?.selections;
        const image = {
          ...emptySelection(),
          ...(persistedSelections?.image ?? {}),
        };
        const video = {
          ...emptySelection(),
          ...(persistedSelections?.video ?? {}),
        };
        // Older versions kept two independent roots. Prefer the image scope
        // when present, then fall back to video, and migrate both together.
        const workspaceId = image.workspaceId ?? video.workspaceId;
        const projectId = image.projectId ?? video.projectId;
        return {
          selections: {
            image: { ...image, workspaceId, projectId },
            video: { ...video, workspaceId, projectId },
          },
        };
      },
    },
  ),
);
