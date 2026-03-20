import { create } from "zustand";

interface UpdateState {
  /** 是否有可用更新 */
  available: boolean;
  /** 新版本号 */
  version: string | null;
  /** 更新说明 */
  body: string | null;
}

interface UpdateActions {
  setUpdate: (version: string, body: string | null) => void;
  clearUpdate: () => void;
}

export const useUpdateStore = create<UpdateState & UpdateActions>((set) => ({
  available: false,
  version: null,
  body: null,
  setUpdate: (version, body) => set({ available: true, version, body }),
  clearUpdate: () => set({ available: false, version: null, body: null }),
}));
