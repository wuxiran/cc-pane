// 灵动岛窗口侧的 IPC 封装（invoke + 发给主窗口的事件）。
import { emitTo } from "@tauri-apps/api/event";
import { invokeIfTauri, listenWebviewIfTauri, type RuntimeEvent } from "./runtime";
import {
  ISLAND_REQUEST_STATE_EVENT,
  ISLAND_RESPOND_PERMISSION_EVENT,
  type IslandEnv,
  type IslandNavigateTarget,
  type IslandPermissionResponse,
  type IslandSettings,
} from "@/types/island";

export interface IslandInitialState {
  settings: IslandSettings;
  env: IslandEnv;
}

export const islandService = {
  getState(): Promise<IslandInitialState | undefined> {
    return invokeIfTauri<IslandInitialState>("island_get_state");
  },
  /** 上报当前可见岛的逻辑尺寸；后端把原生窗口改成正好这么大（窗口外不挡点击）。 */
  setLayout(width: number, height: number): Promise<void | undefined> {
    return invokeIfTauri<void>("island_set_layout", { width, height });
  },
  /** 唤起主窗口并定位到该会话。 */
  activateSession(target: IslandNavigateTarget): Promise<void | undefined> {
    return invokeIfTauri<void>("island_activate_session", { target });
  },
  getTerminalPendingApproval(sessionId: string): Promise<string | null | undefined> {
    return invokeIfTauri<string | null>("get_terminal_pending_approval", { sessionId });
  },
  respondPermission(response: IslandPermissionResponse): Promise<void> {
    return emitTo("main", ISLAND_RESPOND_PERMISSION_EVENT, response);
  },
  requestState(): Promise<void> {
    return emitTo("main", ISLAND_REQUEST_STATE_EVENT);
  },
  listen<T>(event: string, handler: (event: RuntimeEvent<T>) => void) {
    return listenWebviewIfTauri<T>(event, handler);
  },
};
