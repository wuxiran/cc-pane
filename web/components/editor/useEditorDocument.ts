import { useCallback, useState } from "react";
import { useEditorTabsStore } from "@/stores/useEditorTabsStore";
import { useEditorBuffersStore } from "@/stores/useEditorBuffersStore";
import { EMPTY_EDITOR_DOCUMENT, type EditorDocument } from "@/stores/editorDocument";

/** Files tabs retain text while their views unmount; standalone views keep local state. */
export function useEditorDocument(bufferId?: string) {
  const retained = useEditorBuffersStore((state) => bufferId ? state.buffers[bufferId] : undefined);
  const [local, setLocal] = useState(EMPTY_EDITOR_DOCUMENT);
  const document = bufferId ? retained ?? EMPTY_EDITOR_DOCUMENT : local;
  const updateDocument = useCallback((patch: Partial<EditorDocument>) => {
    if (bufferId) useEditorTabsStore.getState().updateBuffer(bufferId, patch);
    else setLocal((current) => ({ ...current, ...patch }));
  }, [bufferId]);
  return { document, updateDocument };
}
