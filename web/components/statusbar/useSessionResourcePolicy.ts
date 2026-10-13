import { useCallback, useState } from "react";
import { systemStatsService } from "@/services/systemStatsService";
import { useSettingsStore } from "@/stores";
import { useTerminalStatusStore } from "@/stores/useTerminalStatusStore";
import type { ResourcePolicyStatus, SessionResourcePolicy } from "@/types";
import { handleErrorSilent } from "@/utils";

/** 资源管理器会话行的三态。 */
export type SessionPolicyMode = "normal" | "yield" | "eco";

/** 从后端上报的状态推出当前档位；没有状态（SSH / 旧 daemon）按"正常"显示。 */
export function policyModeOf(status: ResourcePolicyStatus | null | undefined): SessionPolicyMode {
  if (!status) return "normal";
  if (status.ecoQos) return "eco";
  if (status.lowerPriority) return "yield";
  return "normal";
}

/** 档位 → 下发的策略。"让路"沿用设置里的 CPU 权重；"效率模式"叠加 EcoQoS。 */
export function policyForMode(
  mode: SessionPolicyMode,
  sessionCpuWeight: number | null,
): SessionResourcePolicy {
  switch (mode) {
    case "normal":
      return { lowerPriority: false, cpuWeight: null, ecoQos: false };
    case "yield":
      return { lowerPriority: true, cpuWeight: sessionCpuWeight, ecoQos: false };
    case "eco":
      return { lowerPriority: true, cpuWeight: sessionCpuWeight, ecoQos: true };
  }
}

/**
 * 会话行的策略控制：当前档位来自 `useTerminalStatusStore`（后端随 TERMINAL_STATUS 推），
 * 切换时调 `set_session_resource_policy`，返回值先写回 store 以免等下一次状态事件。
 */
export function useSessionResourcePolicy(sessionId: string) {
  const status = useTerminalStatusStore(
    (state) => state.statusMap.get(sessionId)?.resourcePolicy ?? null,
  );
  const sessionCpuWeight = useSettingsStore(
    (state) => state.settings?.terminal.sessionCpuWeight ?? null,
  );
  const [pending, setPending] = useState(false);

  const setMode = useCallback(
    async (mode: SessionPolicyMode) => {
      setPending(true);
      try {
        const next = await systemStatsService.setSessionResourcePolicy(
          sessionId,
          policyForMode(mode, sessionCpuWeight),
        );
        if (next) {
          useTerminalStatusStore.setState((state) => {
            const current = state.statusMap.get(sessionId);
            if (!current) return state;
            const statusMap = new Map(state.statusMap);
            statusMap.set(sessionId, { ...current, resourcePolicy: next });
            return { statusMap };
          });
        }
      } catch (error) {
        handleErrorSilent(error, "set session resource policy");
      } finally {
        setPending(false);
      }
    },
    [sessionCpuWeight, sessionId],
  );

  return { status, mode: policyModeOf(status), pending, setMode };
}
