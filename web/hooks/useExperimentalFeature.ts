// 实验功能门禁：入口组件据此决定渲染/不渲染。真源是持久化的
// settings.experimental（Rust ExperimentalSettings 镜像），默认全关。
//
// 功能转正时：删掉 Rust/TS 的对应字段，再删掉所有 useExperimentalFeature(id)
// 调用点（tsc 会把残留点全部报出来），不要留一个恒 true 的死开关。
import { useSettingsStore } from "@/stores/useSettingsStore";
import type { AppSettings, ExperimentalFeatureId } from "@/types";

export { experimentalFeatureEnabled } from "@/lib/experimentalGate";

export function isExperimentalFeatureEnabled(
  settings: AppSettings | null | undefined,
  id: ExperimentalFeatureId,
): boolean {
  return settings?.experimental?.[id] === true;
}

/** 订阅单个实验开关；settings 未加载时按关处理（入口宁少勿多）。 */
export function useExperimentalFeature(id: ExperimentalFeatureId): boolean {
  return useSettingsStore((state) => isExperimentalFeatureEnabled(state.settings, id));
}
