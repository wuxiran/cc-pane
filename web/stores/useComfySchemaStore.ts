import { create } from "zustand";
import { mediaService } from "@/services/mediaService";
import { getErrorMessage } from "@/utils";
import type { ComfyObjectInfoResponse } from "@/types/media";

export interface ComfySchemaEntry {
  data: ComfyObjectInfoResponse | null;
  loading: boolean;
  error: string | null;
  requestId: number;
}

interface ComfySchemaState {
  entries: Record<string, ComfySchemaEntry>;
  load: (providerId: string, refresh?: boolean) => Promise<ComfyObjectInfoResponse | null>;
  invalidate: (providerId?: string) => void;
}

let nextRequestId = 0;

export const useComfySchemaStore = create<ComfySchemaState>((set, get) => ({
  entries: {},
  load: async (providerId, refresh = false) => {
    const key = providerId.trim();
    if (!key) return null;
    const current = get().entries[key];
    if (!refresh && current?.data) return current.data;
    const requestId = ++nextRequestId;
    set((state) => ({
      entries: {
        ...state.entries,
        [key]: {
          data: refresh ? null : current?.data ?? null,
          loading: true,
          error: null,
          requestId,
        },
      },
    }));
    try {
      const data = await mediaService.getComfyObjectInfo(key, undefined, refresh);
      if (get().entries[key]?.requestId !== requestId) return data;
      set((state) => ({
        entries: {
          ...state.entries,
          [key]: { data, loading: false, error: null, requestId },
        },
      }));
      return data;
    } catch (error) {
      if (get().entries[key]?.requestId === requestId) {
        set((state) => ({
          entries: {
            ...state.entries,
            [key]: {
              data: current?.data ?? null,
              loading: false,
              error: getErrorMessage(error),
              requestId,
            },
          },
        }));
      }
      return null;
    }
  },
  invalidate: (providerId) => set((state) => {
    if (!providerId) return { entries: {} };
    const entries = { ...state.entries };
    delete entries[providerId];
    return { entries };
  }),
}));
