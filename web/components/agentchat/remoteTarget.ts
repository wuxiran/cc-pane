// 远程 agent chat 的机器选择：可用性判定 + 选中后一次性探测远端系统。
import { checkSshConnectivity } from "@/services/sshMachineService";
import type { AcpRemoteLaunch } from "@/services/agentChatService";
import {
  useAgentChatRemoteStore,
  type AgentChatRemoteTarget,
} from "@/stores/useAgentChatRemoteStore";
import type { SshMachine } from "@/types";
import { getErrorMessage } from "@/utils";

export type RemoteUnsupportedReason = "password" | "routed";

/** 后端远程启动走系统 ssh 的非交互模式：密码认证与代理/跳板都接不上。 */
export function remoteUnsupportedReason(machine: SshMachine): RemoteUnsupportedReason | null {
  if (machine.authMethod === "password") return "password";
  if (machine.proxy || machine.jumpHost) return "routed";
  return null;
}

export function remoteLaunchOf(target: AgentChatRemoteTarget | null | undefined): AcpRemoteLaunch | undefined {
  return target ? { machineId: target.machineId, os: target.os } : undefined;
}

let probeSeq = 0;

/** 选中机器（null = 回到本地）。选中后立即探测一次系统；探测失败不阻止启动尝试。 */
export function selectRemoteMachine(chatId: string, machine: SshMachine | null): void {
  const store = useAgentChatRemoteStore.getState();
  if (!machine) {
    store.setTarget(chatId, null);
    return;
  }
  const seq = ++probeSeq;
  store.setTarget(chatId, {
    machineId: machine.id,
    machineName: machine.name,
    host: machine.host,
    cwd: machine.defaultPath?.trim() || "~",
    os: null,
    probe: { status: "checking" },
    probeSeq: seq,
  });
  checkSshConnectivity(machine.id)
    .then((result) => {
      useAgentChatRemoteStore.getState().finishProbe(chatId, seq, {
        os: result.os ?? null,
        probe: result.reachable
          ? { status: "reachable", latencyMs: result.latencyMs }
          : { status: "unreachable", message: result.message },
      });
    })
    .catch((error: unknown) => {
      useAgentChatRemoteStore.getState().finishProbe(chatId, seq, {
        os: null,
        probe: { status: "unreachable", message: getErrorMessage(error) },
      });
    });
}
