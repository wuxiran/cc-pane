import { create } from "zustand";
// 直接引服务文件而非 "@/services" barrel：workspaceLaunch.ts（utils）引用本 store，
// 走 barrel 会形成 utils → stores → services → utils 循环导入。
import { launchProfileService } from "@/services/launchProfileService";
import { nativeConfigService } from "@/services/nativeConfigService";
import type { LaunchProfile, LaunchProfileDraft, LaunchProfilePreviewRequest, LaunchProfileResolution, NativeConfigPreview } from "@/types";

interface LaunchProfilesState {
  profiles: LaunchProfile[];
  loading: boolean;
  /** 至少成功加载过一次：区分「还没加载」与「真的没有/已删除」（只读展示的降级判断用）。 */
  loaded: boolean;
  load: () => Promise<void>;
  create: (draft: LaunchProfileDraft) => Promise<LaunchProfile>;
  update: (id: string, draft: LaunchProfileDraft) => Promise<LaunchProfile>;
  remove: (id: string) => Promise<void>;
  setDefault: (id: string) => Promise<void>;
  preview: (request: LaunchProfilePreviewRequest) => Promise<LaunchProfileResolution>;
  /** 生效原生配置预览（草稿可未保存）。 */
  previewNativeConfig: (draft: LaunchProfileDraft, cliTool: string) => Promise<NativeConfigPreview>;
  /** 快捷开关：在片段原文里设置 / 删除（value 为 null）一个键，返回新原文（不落盘）。 */
  setNativeConfigKey: (
    cliTool: string,
    fragment: string,
    key: string,
    value: string | number | boolean | null,
  ) => Promise<string>;
}

export const useLaunchProfilesStore = create<LaunchProfilesState>((set, get) => ({
  profiles: [],
  loading: false,
  loaded: false,

  async load() {
    set({ loading: true });
    try {
      const profiles = await launchProfileService.list();
      // 服务返回非数组（测试替身 / 旧后端）时兜成空表，不把 undefined 写进 store。
      set({ profiles: Array.isArray(profiles) ? profiles : [], loaded: true });
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

  previewNativeConfig(draft, cliTool) {
    return nativeConfigService.preview(draft, cliTool);
  },

  setNativeConfigKey(cliTool, fragment, key, value) {
    return nativeConfigService.setKey(cliTool, fragment, key, value);
  },
}));
