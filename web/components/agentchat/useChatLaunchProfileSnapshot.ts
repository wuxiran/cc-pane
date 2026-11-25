// Agent Chat 标签的运行配置快照：会话带着 launchProfileId 出现、配置也能查到时，把当时的
// 名称 / 凭证 / 模型记到标签上（随布局持久化）。之后配置被删也能显示原名。
//
// 同一个 id 已有快照就沿用（不随配置改动重拍）；id 变了（换配置重启）才重拍。
import { useEffect } from "react";
import { buildLaunchProfileSnapshot } from "@/lib/launchProfileSnapshot";
import { usePanesStore } from "@/stores";
import { findTabAcrossLayouts } from "@/stores/panes/crossLayoutSearch";
import { useLaunchProfilesStore } from "@/stores/useLaunchProfilesStore";
import { useProvidersStore } from "@/stores/useProvidersStore";
import type { LaunchProfileSnapshot } from "@/types/launch-profile-snapshot";

export function useChatLaunchProfileSnapshot(
  chatTabId: string | undefined,
  launchProfileId: string | undefined,
): LaunchProfileSnapshot | null {
  const snapshot = usePanesStore((state) =>
    chatTabId ? findTabAcrossLayouts(state, chatTabId)?.tab.launchProfileSnapshot ?? null : null);
  const profiles = useLaunchProfilesStore((state) => state.profiles);
  const loaded = useLaunchProfilesStore((state) => state.loaded);
  const providers = useProvidersStore((state) => state.providers);
  const id = launchProfileId?.trim() || null;

  useEffect(() => {
    if (!chatTabId || !id || !loaded) return;
    if (snapshot?.launchProfileId === id) return;
    if (!(profiles ?? []).some((item) => item.id === id)) return;
    const next = buildLaunchProfileSnapshot(
      { launchProfileId: id },
      { profiles: profiles ?? [], providers: providers ?? [], mode: "chat" },
    );
    usePanesStore.getState().setTabLaunchProfileSnapshot(chatTabId, next);
  }, [chatTabId, id, loaded, profiles, providers, snapshot?.launchProfileId]);

  // 快照对应的不是当前会话的配置（换配置重启、还没重拍）时不用它。
  return snapshot && snapshot.launchProfileId === id ? snapshot : null;
}
