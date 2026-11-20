import { useEffect, useState } from "react";
import { islandService } from "@/services/islandService";
import {
  DEFAULT_ISLAND_SETTINGS,
  EMPTY_ISLAND_SNAPSHOT,
  ISLAND_ENV_EVENT,
  ISLAND_SETTINGS_EVENT,
  ISLAND_STATE_EVENT,
  type IslandEnv,
  type IslandSettings,
  type IslandSnapshot,
} from "@/types/island";

const DEFAULT_ENV: IslandEnv = { fullscreen: false, mainFocused: false };

/** 岛窗口的全部输入：主窗口事件桥推的会话快照 + 后端推的设置 / 环境。只订阅，不轮询。 */
export function useIslandData() {
  const [snapshot, setSnapshot] = useState<IslandSnapshot>(EMPTY_ISLAND_SNAPSHOT);
  const [settings, setSettings] = useState<IslandSettings>(DEFAULT_ISLAND_SETTINGS);
  const [env, setEnv] = useState<IslandEnv>(DEFAULT_ENV);

  useEffect(() => {
    let disposed = false;
    const pending = [
      islandService.listen<IslandSnapshot>(ISLAND_STATE_EVENT, ({ payload }) => {
        if (payload) setSnapshot(payload);
      }),
      islandService.listen<IslandSettings>(ISLAND_SETTINGS_EVENT, ({ payload }) => {
        if (payload) setSettings(payload);
      }),
      islandService.listen<IslandEnv>(ISLAND_ENV_EVENT, ({ payload }) => {
        if (payload) setEnv(payload);
      }),
    ];
    void islandService.getState().then((state) => {
      if (disposed || !state) return;
      setSettings(state.settings);
      setEnv(state.env);
    }).catch(() => {});
    // 监听就绪后再要一次快照：主窗口先于岛启动时，岛错过了之前推的那份。
    void Promise.all(pending).then(() => {
      if (!disposed) void islandService.requestState().catch(() => {});
    }).catch(() => {});
    return () => {
      disposed = true;
      for (const listener of pending) void listener.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  return { snapshot, settings, env };
}

/** 计时显示用的秒级时钟（纯 UI 刷新，只在有计时要显示时走）。 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!active) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
