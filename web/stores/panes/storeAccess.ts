// usePanesStore 的 set/get 访问形态。zustand + immer 中间件下 set 同时接受
// recipe（草稿变更）与 partial（浅合并）两种调用形；action 工厂只依赖这两种。
import type { PanesDraft, PanesState } from "../panesStoreTypes";

export type PanesSetState = {
  (recipe: (state: PanesDraft) => void): void;
  (partial: Partial<PanesState>): void;
};

export interface PanesStoreAccess {
  set: PanesSetState;
  get: () => PanesState;
}
