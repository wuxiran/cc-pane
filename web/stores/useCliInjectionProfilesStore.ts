// CLI 注入能力描述的前端单源（docs/110 批 0）。
//
// 初始值就是静态兜底 `@/lib/cliInjectionProfiles.json`（Rust 测试
// `web_fallback_matches_registry_profiles` 保证与后端注册表逐字段一致），所以测试、web 模式、
// 加载失败时都能同步读到正确的值；桌面端启动时 `loadCliInjectionProfiles()` 拉一次后端的
// 实时描述覆盖它（旧后端没有这条命令时保持兜底）。
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import {
  FALLBACK_INJECTION_PROFILES,
  getCliInjectionProfiles,
} from "@/services/cliInjectionProfileService";
import type { InjectionProfile, InjectionProfileMap } from "@/types/cliInjectionProfile";

interface CliInjectionProfilesState {
  profiles: InjectionProfileMap;
  /** 后端描述已加载（false = 仍是静态兜底）。 */
  loaded: boolean;
  setProfiles: (profiles: InjectionProfileMap) => void;
}

export const useCliInjectionProfilesStore = create<CliInjectionProfilesState>()(
  immer((set) => ({
    profiles: FALLBACK_INJECTION_PROFILES,
    loaded: false,
    setProfiles: (profiles) =>
      set((state) => {
        state.profiles = profiles;
        state.loaded = true;
      }),
  })),
);

let loading: Promise<void> | null = null;

/** 启动时调用一次；重复调用复用同一个请求。失败只记日志，继续用兜底。 */
export function loadCliInjectionProfiles(): Promise<void> {
  if (loading) return loading;
  loading = getCliInjectionProfiles()
    .then((profiles) => {
      if (profiles && Object.keys(profiles).length > 0) {
        useCliInjectionProfilesStore.getState().setProfiles(profiles);
      }
    })
    .catch((error) => {
      console.warn("[cliInjectionProfiles] falling back to the bundled profiles:", error);
    });
  return loading;
}

/** 同步读取（渲染外 / 纯函数用）：未知 CLI（含 `none`）返回 null。 */
export function injectionProfileFor(cliTool: string): InjectionProfile | null {
  return useCliInjectionProfilesStore.getState().profiles[cliTool] ?? null;
}

/** 组件内读取单个 CLI 的描述（选稳定引用，不在 selector 里构造新对象）。 */
export function useInjectionProfile(cliTool: string): InjectionProfile | null {
  return useCliInjectionProfilesStore((state) => state.profiles[cliTool] ?? null);
}

/** 仅供测试：恢复为静态兜底。 */
export function resetCliInjectionProfilesForTest(): void {
  loading = null;
  useCliInjectionProfilesStore.setState({ profiles: FALLBACK_INJECTION_PROFILES, loaded: false });
}
