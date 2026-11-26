// 读隐私开关（设置 → 隐私）。全部默认关闭；没开时入口组件直接不渲染。
import { useSettingsStore } from "@/stores/useSettingsStore";
import type { PrivacySettings } from "@/types";

export function usePrivacyFeature(id: keyof PrivacySettings): boolean {
  return useSettingsStore((state) => state.settings?.privacy?.[id] === true);
}
