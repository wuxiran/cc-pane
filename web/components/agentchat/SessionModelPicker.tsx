// 会话 composer 里的合并选择器：模型 / 推理档位 / 访问模式 + 换引擎（上下文交接）。
// 换引擎沿用 ChatEngineSwitch 的既有流程（switchChatEngine）；目标模型先记成该引擎的偏好，
// 新会话就绪后由 startConfiguredChat 的 applyPreferences 应用。
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { codexEngineLabel } from "@/lib/codexIntegration";
import { agentChatService } from "@/services/agentChatService";
import { useAgentChatRemoteStore } from "@/stores/useAgentChatRemoteStore";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import type { AcpChatSnapshot, AcpEngineInfo } from "@/types/agentChat";
import { handleErrorSilent } from "@/utils/errorHandler";
import ChatModelPicker, { type PickerEngine } from "./ChatModelPicker";
import { canSwitchEngine, handoffTargets, switchChatEngine } from "./chatEngineHandoff";
import { effortControl, snapshotModels, type PickerModelRow } from "./chatModelPickerModel";
import { loadEnginePrefs, savePreferredModel } from "./enginePrefs";

interface SessionModelPickerProps {
  chatId: string;
  snapshot: AcpChatSnapshot;
  cwd?: string;
  /** false = 只能在当前引擎内选（bot 对话 / 无 cwd）。 */
  allowSwitch: boolean;
  onSelectModel: (modelId: string) => void;
  onSelectEffort: (value: string) => void;
  footer?: ReactNode;
}

export default function SessionModelPicker({
  chatId, snapshot, cwd, allowSwitch, onSelectModel, onSelectEffort, footer,
}: SessionModelPickerProps) {
  const { t } = useTranslation("panes");
  const engineId = snapshot.engineId;
  const switchEnabled = useAgentChatStore((state) => canSwitchEngine(state.chats[chatId]));
  const remote = useAgentChatRemoteStore((state) => Boolean(state.targets[chatId]));
  const [engines, setEngines] = useState<AcpEngineInfo[] | null>(null);

  const loadEngines = useCallback((open: boolean) => {
    if (!open || !allowSwitch) return;
    agentChatService.listEngines()
      .then(setEngines)
      .catch((error) => {
        handleErrorSilent(error, "list acp engines for model picker");
        setEngines([]);
      });
  }, [allowSwitch]);

  const pickerEngines = useMemo<PickerEngine[]>(() => {
    const listed = allowSwitch ? engines ?? [] : [];
    const toPicker = (engine: AcpEngineInfo): PickerEngine => ({
      id: engine.id, label: codexEngineLabel(engine.id, engine.label), available: engine.available, requirement: engine.requirement,
    });
    const current = listed.find((engine) => engine.id === engineId);
    const head: PickerEngine = current ? toPicker(current) : { id: engineId, label: codexEngineLabel(engineId), available: true };
    return [head, ...listed.filter((engine) => engine.id !== engineId).map(toPicker)];
  }, [allowSwitch, engines, engineId]);

  const { rows: currentRows, currentId } = snapshotModels(snapshot);
  const modelsOf = useCallback((id: string): PickerModelRow[] => {
    const rows = id === engineId
      ? currentRows
      : (loadEnginePrefs(id)?.models ?? []).map((model) => ({
        engineId: id, modelId: model.modelId, label: model.name || model.modelId, description: model.description,
      }));
    return rows.length > 0 ? rows : [{ engineId: id, modelId: null, label: t("agentChatModelDefault") }];
  }, [engineId, currentRows, t]);

  const targets = engines ? handoffTargets(engines, engineId, remote) : [];
  const blockedReason = (id: string): string | null => {
    if (!allowSwitch || !cwd) return t("agentChatHandoffNoEngines");
    if (!switchEnabled) return t("agentChatHandoffDisabled");
    if (targets.some((engine) => engine.id === id)) return null;
    return engines?.find((engine) => engine.id === id)?.requirement || t("agentChatUnavailableEngine");
  };

  const pickModel = (targetId: string, modelId: string | null) => {
    if (targetId === engineId) {
      if (modelId !== null) onSelectModel(modelId);
      return;
    }
    const target = targets.find((engine) => engine.id === targetId);
    if (!target || !cwd) return;
    if (modelId !== null) savePreferredModel(targetId, modelId);
    const currentLabel = engines?.find((engine) => engine.id === engineId)?.label || codexEngineLabel(engineId);
    void switchChatEngine({ chatId, target, currentEngineLabel: currentLabel, cwd })
      .catch((error) => handleErrorSilent(error, "switch acp chat engine"));
  };

  return (
    <ChatModelPicker
      engines={pickerEngines}
      currentEngineId={engineId}
      currentModelId={currentId}
      modelsOf={modelsOf}
      blockedReason={blockedReason}
      switchHint={t("agentChatHandoffSwitchHint")}
      effort={effortControl(snapshot.configOptions)}
      onPickModel={pickModel}
      onPickEffort={onSelectEffort}
      footer={footer}
      onOpenChange={loadEngines}
    />
  );
}
