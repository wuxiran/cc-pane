import { create } from "zustand";

interface UpdateState {
  /** 是否有可用更新 */
  available: boolean;
  /** 新版本号 */
  version: string | null;
  /** 更新说明 */
  body: string | null;
  /** 上次检查失败的原因（成功一次即清空） */
  lastCheckError: string | null;
  /** 上次检查失败的时间（ISO） */
  lastCheckFailedAt: string | null;
}

interface UpdateActions {
  setUpdate: (version: string, body: string | null) => void;
  clearUpdate: () => void;
  setCheckFailure: (error: string, failedAt: string) => void;
}

export const useUpdateStore = create<UpdateState & UpdateActions>((set) => ({
  available: false,
  version: null,
  body: null,
  lastCheckError: null,
  lastCheckFailedAt: null,
  // 成功检查清掉失败痕迹，否则设置页会一直挂着一条早已恢复的旧错误。
  setUpdate: (version, body) =>
    set({ available: true, version, body, lastCheckError: null, lastCheckFailedAt: null }),
  clearUpdate: () =>
    set({
      available: false,
      version: null,
      body: null,
      lastCheckError: null,
      lastCheckFailedAt: null,
    }),
  // 检查失败**不动** available/version/body：上次查到的更新确实还在，网络断了不代表
  // 它没了；清掉反而会让「本来提示有更新、断一次网就消失」。版本号可能因此偏旧，
  // 但设置→关于会同时显示失败原因与时间，用户拿得到判断依据。
  setCheckFailure: (error, failedAt) =>
    set({ lastCheckError: error, lastCheckFailedAt: failedAt }),
}));
