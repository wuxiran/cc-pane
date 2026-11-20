// 每个 agent chat 的远程运行目标（SSH 机器 + 远端目录）。与 useAgentChatStore 分开存：
// 那边是会话渲染态，这里是启动态——启动页选机器、restart/重试沿用同一台机器。
// 没有条目 = 本地会话（默认）。关标签时由 dropAgentChatState 一并回收。
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

export type AgentChatRemoteProbe =
  | { status: "checking" }
  | { status: "reachable"; latencyMs: number | null }
  | { status: "unreachable"; message: string };

export interface AgentChatRemoteTarget {
  machineId: string;
  machineName: string;
  host: string;
  /** 远端工作目录（`~`、`~/x`、`/abs` 或 Windows 路径），原样交给后端解析。 */
  cwd: string;
  /** 连通性检测得到的远端系统；检测前/未知为 null（后端按 POSIX 处理）。 */
  os: string | null;
  probe: AgentChatRemoteProbe;
  /** 检测序号：换机器后旧检测结果不得覆盖新目标。 */
  probeSeq: number;
}

interface AgentChatRemoteState {
  targets: Record<string, AgentChatRemoteTarget>;
  setTarget: (chatId: string, target: AgentChatRemoteTarget | null) => void;
  setRemoteCwd: (chatId: string, cwd: string) => void;
  finishProbe: (
    chatId: string,
    probeSeq: number,
    result: { os: string | null; probe: AgentChatRemoteProbe },
  ) => void;
}

export const useAgentChatRemoteStore = create<AgentChatRemoteState>()(
  immer((set) => ({
    targets: {},
    setTarget: (chatId, target) =>
      set((state) => {
        if (target) state.targets[chatId] = target;
        else delete state.targets[chatId];
      }),
    setRemoteCwd: (chatId, cwd) =>
      set((state) => {
        const target = state.targets[chatId];
        if (target) target.cwd = cwd;
      }),
    finishProbe: (chatId, probeSeq, result) =>
      set((state) => {
        const target = state.targets[chatId];
        if (!target || target.probeSeq !== probeSeq) return;
        target.os = result.os;
        target.probe = result.probe;
      }),
  })),
);

export function getAgentChatRemoteTarget(chatId: string): AgentChatRemoteTarget | null {
  return useAgentChatRemoteStore.getState().targets[chatId] ?? null;
}

export function dropAgentChatRemote(chatId: string): void {
  useAgentChatRemoteStore.getState().setTarget(chatId, null);
}
