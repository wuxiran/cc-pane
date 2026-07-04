import { create } from "zustand";
// 直接引服务文件而非 "@/services" barrel：workspaceLaunch.ts（utils）引用本 store，
// 走 barrel 会形成 utils → stores → services → utils 循环导入。
import { launchProfileService } from "@/services/launchProfileService";
import type { LaunchProfile, LaunchProfileDraft, LaunchProfilePreviewRequest, LaunchProfileResolution } from "@/types";

interface LaunchProfilesState {
  profiles: LaunchProfile[];
  loading: boolean;
  load: () => Promise<void>;
  create: (draft: LaunchProfileDraft) => Promise<LaunchProfile>;
  update: (id: string, draft: LaunchProfileDraft) => Promise<LaunchProfile>;
  remove: (id: string) => Promise<void>;
  setDefault: (id: string) => Promise<void>;
  preview: (request: LaunchProfilePreviewRequest) => Promise<LaunchProfileResolution>;
}

export const useLaunchProfilesStore = create<LaunchProfilesState>((set, get) => ({
  profiles: [],
  loading: false,

  async load() {
    set({ loading: true });
    try {
      const profiles = await launchProfileService.list();
      set({ profiles });
    } finally {
      set({ loading: false });
    }
  },

  async create(draft) {
    const profile = await launchProfileService.create(draft);
    await get().load();
    return profile;
  },

  async update(id, draft) {
    const profile = await launchProfileService.update(id, draft);
    await get().load();
    return profile;
  },

  async remove(id) {
    await launchProfileService.remove(id);
    await get().load();
  },

  async setDefault(id) {
    await launchProfileService.setDefault(id);
    await get().load();
  },

  preview(request) {
    return launchProfileService.preview(request);
  },
}));
