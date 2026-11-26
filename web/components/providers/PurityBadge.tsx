// 中转纯度标记：一个小药丸显示最近一次检测的结论，点开看每个型号的证据、开始 / 重新检测。
// 只对能检测的供应商（Claude / OpenAI 接口 + API key 账号）显示。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PurityVerdict } from "@/services";
import { purityCheckable, useChannelPurityStore } from "@/stores/useChannelPurityStore";
import type { Provider } from "@/types/provider";
import { cn } from "@/lib/utils";
import { usePrivacyFeature } from "@/hooks/usePrivacyFeature";
import PurityDialog from "./PurityDialog";
import { STATE_COLOR, StateIcon, useEnsureLoaded, type BadgeState } from "./purityShared";

/** 设置 → 隐私里没打开、或这条供应商不能检测时什么都不渲染（也不去读检测状态）。 */
export default function PurityBadge({ provider, className }: { provider: Provider; className?: string }) {
  const enabled = usePrivacyFeature("channelPurity");
  if (!enabled || !purityCheckable(provider)) return null;
  return <PurityBadgeInner provider={provider} className={className} />;
}

function PurityBadgeInner({ provider, className }: { provider: Provider; className?: string }) {
  const { t } = useTranslation("providers");
  useEnsureLoaded();
  const report = useChannelPurityStore((s) => s.reports[provider.id]);
  const job = useChannelPurityStore((s) => s.job);
  const [open, setOpen] = useState(false);

  const running = job?.stage === "running" && job.providerId === provider.id;
  const state: BadgeState = running ? "running" : report?.verdict ?? "unchecked";
  const label = running ? t("purity.running", { done: job.done, total: job.total }) : t(`purity.verdict.${state as PurityVerdict | "unchecked"}`);

  return (
    <>
      <button
        type="button"
        data-testid="purity-badge"
        data-state={state}
        aria-label={`${t("purity.title")}: ${label}`}
        title={t("purity.openDetails")}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0 text-[length:var(--text-nano)] leading-[18px] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)]",
          className,
        )}
        style={{ color: STATE_COLOR[state], borderColor: STATE_COLOR[state] }}
      >
        <StateIcon state={state} size={11} />
        {label}
      </button>
      {open && <PurityDialog provider={provider} onClose={() => setOpen(false)} />}
    </>
  );
}
