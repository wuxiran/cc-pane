/** Text buffers belong to open file tabs, not to the mounted Monaco view. */
export interface EditorDocument {
  content: string;
  originalContent: string;
  modified: string | null;
  loaded: boolean;
  readOnly: boolean;
  readOnlyReason: "path" | "encoding" | null;
}

export const EMPTY_EDITOR_DOCUMENT: EditorDocument = {
  content: "",
  originalContent: "",
  modified: null,
  loaded: false,
  readOnly: false,
  readOnlyReason: null,
};
