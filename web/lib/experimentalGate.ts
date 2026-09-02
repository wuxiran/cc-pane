// 实验功能门禁的零依赖注册点。
//
// 为什么不直接在 store 里 import useSettingsStore：useSettingsStore 拖着
// services / sidebar launchMenu 一整张图，从 useActivityBarStore 静态引用会在
// 模块求值期绕回 stores index → useWallpaperStore 对尚未初始化的 settings
// store 调 subscribe（实测测试直接炸）。这里只放一个函数指针，settings store
// 加载时把真实判定注册进来；未注册时一律按「关」处理（宁少勿多）。
import type { ExperimentalFeatureId } from "@/types";

type ExperimentalGate = (id: ExperimentalFeatureId) => boolean;

let gate: ExperimentalGate = () => false;

export function registerExperimentalGate(next: ExperimentalGate): void {
  gate = next;
}

/** 非 React 上下文（store action / 事件回调）读取实验开关。 */
export function experimentalFeatureEnabled(id: ExperimentalFeatureId): boolean {
  return gate(id);
}
