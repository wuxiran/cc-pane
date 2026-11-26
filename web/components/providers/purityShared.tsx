// 纯度标记与详情弹窗共用：状态配色、图标、首次加载。
import { useEffect } from "react";
import { Loader2, ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX } from "lucide-react";
import type { PurityVerdict } from "@/services";
import { useChannelPurityStore } from "@/stores/useChannelPurityStore";

export type BadgeState = PurityVerdict | "unchecked" | "running";

export const STATE_COLOR: Record<BadgeState, string> = {
  clean: "var(--app-status-success)",
  suspicious: "var(--app-status-warning)",
  injected: "var(--app-status-danger)",
  adulterated: "var(--app-status-danger)",
  inconclusive: "var(--app-text-tertiary)",
  unchecked: "var(--app-text-tertiary)",
  running: "var(--app-accent)",
};

export function StateIcon({ state, size }: { state: BadgeState; size: number }) {
  switch (state) {
    case "running":
      return <Loader2 size={size} className="animate-spin" aria-hidden="true" />;
    case "clean":
      return <ShieldCheck size={size} aria-hidden="true" />;
    case "suspicious":
      return <ShieldAlert size={size} aria-hidden="true" />;
    case "injected":
    case "adulterated":
      return <ShieldX size={size} aria-hidden="true" />;
    default:
      return <ShieldQuestion size={size} aria-hidden="true" />;
  }
}

/** 确保状态加载过一次（多个标记共用一个 store）。 */
export function useEnsureLoaded() {
  const loaded = useChannelPurityStore((s) => s.loaded);
  const load = useChannelPurityStore((s) => s.load);
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);
}
