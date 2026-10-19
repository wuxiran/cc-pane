import { create } from "zustand";
import type { EditorDocument } from "./editorDocument";

interface EditorBuffersState {
  buffers: Record<string, EditorDocument>;
  put: (tabId: string, document: EditorDocument) => void;
  retain: (tabIds: ReadonlySet<string>) => void;
}

// Separate from persisted tab metadata: typing must not write localStorage on every key.
export const useEditorBuffersStore = create<EditorBuffersState>((set) => ({
  buffers: {},
  put: (tabId, document) => set((state) => ({ buffers: { ...state.buffers, [tabId]: document } })),
  retain: (tabIds) => set((state) => ({
    buffers: Object.fromEntries(Object.entries(state.buffers).filter(([id]) => tabIds.has(id))),
  })),
}));
