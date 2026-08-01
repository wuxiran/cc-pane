import { create } from "zustand";
import type { RestoreReportSummary } from "@/utils/restoreReport";

/**
 * 启动时那一次恢复报告的结果，供 `RestoreRegressionBanner` 消费。
 *
 * 为什么要有这个 store：报告本来只写进 cc-panes.log，而没有人会去 grep 日志——
 * resume id 落库链断掉后连续三天 100% 未绑定，全靠用户抱怨「会话没恢复」才被发现
 * （docs/69）。修好落库链只是止血，不把回归**摆到眼前**，下次断了照样无人知晓。
 *
 * 只保存一次（应用启动那次），不随会话增减刷新：它描述的是「这次重启恢复得怎么样」。
 */
type RestoreReportState = {
  summary: RestoreReportSummary | null;
  /** 用户手动关掉横幅后不再打扰，直到下次启动。 */
  dismissed: boolean;
  setSummary: (summary: RestoreReportSummary) => void;
  dismiss: () => void;
};

export const useRestoreReportStore = create<RestoreReportState>((set) => ({
  summary: null,
  dismissed: false,
  setSummary: (summary) => set({ summary }),
  dismiss: () => set({ dismissed: true }),
}));
