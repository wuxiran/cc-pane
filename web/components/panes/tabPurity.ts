// 标签页右键「检测中转纯度」：设置 → 隐私里打开了、且这个 CLI 标签启动时用的供应商 + 账号能检测时才出现。
import { usePrivacyFeature } from "@/hooks/usePrivacyFeature";
import { useProvidersStore } from "@/stores";
import { purityCheckable } from "@/stores/useChannelPurityStore";
import type { Tab } from "@/types";
import type { Provider } from "@/types/provider";

export function useTabPurityProvider(tab: Tab): Provider | null {
  const enabled = usePrivacyFeature("channelPurity");
  const provider = useProvidersStore((s) =>
    tab.contentType === "terminal" && tab.providerId
      ? s.providers.find((candidate) => candidate.id === tab.providerId)
      : undefined,
  );
  return enabled && provider && purityCheckable(provider, tab.providerAccountId) ? provider : null;
}
