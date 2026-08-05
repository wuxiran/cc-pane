import { create } from "zustand";

export interface EditorRevealRequest {
  requestId: number;
  filePath: string;
  line: number;
  column?: number;
}

interface EditorRevealStore {
  requestSequence: number;
  requests: Record<string, EditorRevealRequest>;
  request(filePath: string, line: number, column?: number): number;
  acknowledge(filePath: string, requestId: number): void;
  resetForTest(): void;
}

export const useEditorRevealStore = create<EditorRevealStore>((set, get) => ({
  requestSequence: 0,
  requests: {},

  request(filePath, line, column) {
    const requestId = get().requestSequence + 1;
    set((state) => ({
      requestSequence: requestId,
      requests: {
        ...state.requests,
        [filePath]: { requestId, filePath, line, column },
      },
    }));
    return requestId;
  },

  acknowledge(filePath, requestId) {
    set((state) => {
      if (state.requests[filePath]?.requestId !== requestId) return state;
      const requests = { ...state.requests };
      delete requests[filePath];
      return { requests };
    });
  },

  resetForTest() {
    set({ requestSequence: 0, requests: {} });
  },
}));

