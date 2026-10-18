// Session controls shared by the live composer and setup recovery.
import { Cpu, SlidersHorizontal } from "lucide-react";
import type { AcpChatSnapshot } from "@/types/agentChat";
import { agentChatService } from "@/services/agentChatService";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import ConfigOptionSelectors, { selectableConfigOptions } from "./ConfigOptionSelectors";
import { HeaderSelect } from "./ChatItems";
import PermissionPolicyDropdown from "./PermissionPolicyDropdown";
import {
  saveAutoApproveKinds,
  saveEngineModels,
  saveEngineModes,
  savePreferredConfigOption,
  savePreferredMode,
  savePreferredModel,
} from "./enginePrefs";

interface ChatSessionControlsProps {
  chatId: string;
  snapshot: AcpChatSnapshot;
  setupRecovery: boolean;
  recoverySelections: Readonly<Record<string, string>>;
  onRecoverySelect: (key: string, value: string) => void;
}

export default function ChatSessionControls({
  chatId, snapshot, setupRecovery, recoverySelections, onRecoverySelect,
}: ChatSessionControlsProps) {
  const recoveryConfigCategories = new Set(setupRecovery
    ? selectableConfigOptions(snapshot?.configOptions, new Set()).map((option) => option.category)
    : []);
  const modeItems = (recoveryConfigCategories.has("mode") ? [] : snapshot?.modes?.availableModes ?? []).map((mode) => ({
    id: mode.id,
    label: mode.name || mode.id,
    description: mode.description,
  }));
  const modelItems = (recoveryConfigCategories.has("model") ? [] : snapshot?.models?.availableModels ?? []).map((model) => ({
    id: model.modelId,
    label: model.name || model.modelId,
    description: model.description,
  }));
  const autoApproveKinds = snapshot?.autoApproveKinds ?? [];
  // legacy 选择器在渲染的类别，configOptions 里同类不再重复出一个。
  const legacyCategories = new Set<string>([
    ...(modelItems.length > 0 ? ["model"] : []),
    ...(modeItems.length > 0 ? ["mode"] : []),
  ]);

  const pushError = (error: unknown) => {
    useAgentChatStore
      .getState()
      .pushNotice(chatId, error instanceof Error ? error.message : String(error));
  };

  return (
    <>
      {modelItems.length > 0 ? (
        <HeaderSelect
          icon={<Cpu className="h-3.5 w-3.5 shrink-0 opacity-70" />}
          items={modelItems}
          currentId={setupRecovery ? recoverySelections.model ?? snapshot.models?.currentModelId : snapshot.models?.currentModelId}
          onSelect={(modelId) => {
            // 记为该引擎的偏好模型，下次启动页直接可选并自动应用。
            savePreferredModel(snapshot.engineId, modelId);
            saveEngineModels(snapshot.engineId, snapshot.models?.availableModels ?? []);
            if (setupRecovery) {
              onRecoverySelect("model", modelId);
              return;
            }
            void agentChatService.setModel(chatId, modelId).catch(pushError);
          }}
        />
      ) : null}
      {modeItems.length > 0 ? (
        <HeaderSelect
          icon={<SlidersHorizontal className="h-3.5 w-3.5 shrink-0 opacity-70" />}
          items={modeItems}
          currentId={setupRecovery ? recoverySelections.mode ?? snapshot.modes?.currentModeId : snapshot.modes?.currentModeId}
          onSelect={(modeId) => {
            savePreferredMode(snapshot.engineId, modeId);
            saveEngineModes(snapshot.engineId, snapshot.modes?.availableModes ?? []);
            if (setupRecovery) {
              onRecoverySelect("mode", modeId);
              return;
            }
            void agentChatService.setMode(chatId, modeId).catch(pushError);
          }}
        />
      ) : null}
      <ConfigOptionSelectors
        options={setupRecovery ? snapshot.configOptions?.map((option) => ({
          ...option, currentValue: recoverySelections[`config:${option.configId}`] ?? option.currentValue,
        })) : snapshot.configOptions}
        hiddenCategories={legacyCategories}
        onSelect={(option, value) => {
          // mode/model 类别（legacy 缺席时才从这里出）沿用原偏好字段；其余记进配置项偏好。
          if (option.category === "model") savePreferredModel(snapshot.engineId, value);
          else if (option.category === "mode") savePreferredMode(snapshot.engineId, value);
          else savePreferredConfigOption(snapshot.engineId, option.configId, value);
          if (setupRecovery) {
            onRecoverySelect(`config:${option.configId}`, value);
            return;
          }
          void agentChatService.setConfigOption(chatId, option.configId, value).catch(pushError);
        }}
      />
      {!setupRecovery ? <PermissionPolicyDropdown
        kinds={autoApproveKinds}
        onChange={(kinds) => {
          // 同时落为引擎偏好（下次启动沿用）并对当前会话立即生效。
          saveAutoApproveKinds(snapshot.engineId, kinds);
          void agentChatService.setAutoApprove(chatId, kinds).catch(pushError);
        }}
      /> : null}
    </>
  );
}
