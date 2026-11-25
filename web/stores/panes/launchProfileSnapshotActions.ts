// 运行配置快照的写入 actions（终端 leaf / 非终端标签）。在 usePanesStore 里 spread 挂载。
//
// 写入时机：会话建好之后（syncTerminalProviderAccount 读回启动历史后统一调一次；
// orchestrator 派发的标签在落位后调一次）。快照只读展示用，任何失败都静默放弃，
// 保留旧快照——展示层没有快照时自动回落到「按当前配置推断」的旧口径。
import { buildLaunchProfileSnapshot } from "@/lib/launchProfileSnapshot";
import { notifyTerminalLayoutChanged, syncTabTerminalState } from "@/lib/paneTree";
import { findTerminalPane } from "@/lib/paneSessions";
import type { LaunchProfileSnapshot } from "@/types/launch-profile-snapshot";
import { useLaunchProfilesStore } from "../useLaunchProfilesStore";
import { useProvidersStore } from "../useProvidersStore";
import { useWorkspacesStore } from "../useWorkspacesStore";
import type { PanesState } from "../panesStoreTypes";
import { findTabAcrossLayouts } from "./crossLayoutSearch";
import type { PanesStoreAccess } from "./storeAccess";

export type LaunchProfileSnapshotActions = Pick<
  PanesState,
  "captureTerminalLaunchProfileSnapshot" | "setTabLaunchProfileSnapshot"
>;

async function ensureLaunchProfilesLoaded(): Promise<boolean> {
  const store = useLaunchProfilesStore.getState();
  if (store.loaded) return true;
  await store.load();
  return useLaunchProfilesStore.getState().loaded;
}

/** 除记录时间外内容一致 = 沿用原快照（不重写，capturedAt 保留启动那一刻）。 */
export function sameLaunchProfileSnapshot(
  a: LaunchProfileSnapshot | undefined | null,
  b: LaunchProfileSnapshot,
): boolean {
  if (!a) return false;
  const { capturedAt: _a, ...left } = a;
  const { capturedAt: _b, ...right } = b;
  return JSON.stringify(left, Object.keys(left).sort()) === JSON.stringify(right, Object.keys(right).sort());
}

export function createLaunchProfileSnapshotActions({ set, get }: PanesStoreAccess): LaunchProfileSnapshotActions {
  return {
    captureTerminalLaunchProfileSnapshot: async (tabId, terminalPaneId, launchId) => {
      try {
        if (!(await ensureLaunchProfilesLoaded())) return;
        const location = findTabAcrossLayouts(get(), tabId);
        const tab = location?.tab;
        if (!tab || tab.contentType !== "terminal" || !tab.terminalRootPane) return;
        const leafId = terminalPaneId ?? tab.activeTerminalPaneId ?? "";
        const leaf = findTerminalPane(tab.terminalRootPane, leafId);
        // launchId 变了 = 这个 leaf 已经重新启动过，本次结果不能写上去。
        if (leaf?.type !== "leaf" || (launchId && leaf.launchId !== launchId)) return;
        const cliTool = (leaf.cliTool ?? tab.cliTool)?.trim().toLowerCase();
        if (!cliTool || cliTool === "none") return;
        const workspaceName = leaf.workspaceName ?? tab.workspaceName;
        const workspace = workspaceName
          ? useWorkspacesStore.getState().workspaces?.find((item) => item.name === workspaceName)
          : undefined;
        const built = buildLaunchProfileSnapshot(
          {
            launchProfileId: leaf.launchProfileId ?? leaf.launchProfileSnapshot?.launchProfileId,
            workspaceLaunchProfileId: workspace?.launchProfileId,
            cliTool,
            providerId: leaf.providerId,
            providerAccountId: leaf.providerAccountId,
            providerSelection: leaf.providerSelection,
            modelId: leaf.modelId,
          },
          {
            profiles: useLaunchProfilesStore.getState().profiles ?? [],
            providers: useProvidersStore.getState().providers ?? [],
            mode: "terminal",
          },
        );
        // 沿用快照 id 重新启动时，这个 id 是从快照里来的而不是点名的：「默认配置回落」的身份照旧。
        const previous = leaf.launchProfileSnapshot;
        const inheritsImplicit = !leaf.launchProfileId?.trim()
          && previous?.implicitDefault && previous.launchProfileId === built.launchProfileId;
        const snapshot = inheritsImplicit ? { ...built, implicitDefault: true } : built;
        if (sameLaunchProfileSnapshot(previous, snapshot)) return;
        let changed = false;
        set((state) => {
          const current = findTabAcrossLayouts(state, tabId)?.tab;
          if (!current?.terminalRootPane) return;
          const target = findTerminalPane(current.terminalRootPane, leafId);
          if (target?.type !== "leaf" || (launchId && target.launchId !== launchId)) return;
          target.launchProfileSnapshot = snapshot;
          syncTabTerminalState(current);
          changed = true;
        });
        if (changed) notifyTerminalLayoutChanged("launch-profile-snapshot.update");
      } catch (error) {
        console.warn("[panes] failed to capture the launch profile snapshot:", error);
      }
    },

    setTabLaunchProfileSnapshot: (tabId, snapshot) => {
      let changed = false;
      set((state) => {
        const tab = findTabAcrossLayouts(state, tabId)?.tab;
        if (!tab) return;
        if (snapshot && sameLaunchProfileSnapshot(tab.launchProfileSnapshot, snapshot)) return;
        tab.launchProfileSnapshot = snapshot;
        changed = true;
      });
      if (changed) notifyTerminalLayoutChanged("launch-profile-snapshot.update");
    },
  };
}
