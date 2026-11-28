import type { KeepAwakeReport } from "@/types";
import { invokeIfTauri } from "./runtime";

export const keepAwakeService = {
  /** 当前是否持有「阻止系统空闲休眠」锁。非桌面运行时返回 undefined。 */
  getStatus: () => invokeIfTauri<KeepAwakeReport>("get_keep_awake_status"),
};
