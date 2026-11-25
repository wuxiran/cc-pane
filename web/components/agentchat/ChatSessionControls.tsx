// Session controls shared by the live composer and setup recovery.
import { Cpu, SlidersHorizontal } from "lucide-react";
import type { AcpChatSnapshot, AcpConfigOption } from "@/types/agentChat";
import { agentChatService } from "@/services/agentChatService";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import ConfigOptionSelectors, { selectableConfigOptions } from "./ConfigOptionSelectors";
import { HeaderSelect } from "./ChatItems";
import PermissionPolicyDropdown from "./PermissionPolicyDropdown";
import SessionModelPicker from "./SessionModelPicker";
import { effortControl, isPickerManagedOption, snapshotModels } from "./chatModelPickerModel";
import { botIdOfChat } from "@/types/bot";
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
  /** 当前会话生效的工作目录；给出时显示「切换引擎」（上下文交接）。 */
  cwd?: string;
}

export default function ChatSessionControls({
  chatId, snapshot, setupRecovery, recoverySelections, onRecoverySelect, cwd,
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

  const selectModel = (modelId: string) => {
    // 记为该引擎的偏好模型，下次启动页直接可选并自动应用。
    savePreferredModel(snapshot.engineId, modelId);
    saveEngineModels(snapshot.engineId, snapshot.models?.availableModels ?? []);
    if (setupRecovery) {
      onRecoverySelect("model", modelId);
      return;
    }
    void agentChatService.setModel(chatId, modelId).catch(pushError);
  };
  const selectConfig = (option: AcpConfigOption, value: string) => {
    // mode/model 类别（legacy 缺席时才从这里出）沿用原偏好字段；其余记进配置项偏好。
    if (option.category === "model") savePreferredModel(snapshot.engineId, value);
    else if (option.category === "mode") savePreferredMode(snapshot.engineId, value);
    else savePreferredConfigOption(snapshot.engineId, option.configId, value);
    if (setupRecovery) {
      onRecoverySelect(`config:${option.configId}`, value);
      return;
    }
    void agentChatService.setConfigOption(chatId, option.configId, value).catch(pushError);
  };
  const modeSelect = modeItems.length > 0 ? (
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
  ) : null;
  const configSelect = (options: AcpConfigOption[] | undefined) => (
    <ConfigOptionSelectors options={options} hiddenCategories={legacyCategories} onSelect={selectConfig} />
  );

  if (!setupRecovery) {
    // 合并选择器接管 引擎 / 模型 / 推理档位 / 访问模式；其余配置项与权限预设照旧独立。
    const options = snapshot.configOptions ?? [];
    const modeConfig = options.filter((option) => option.category === "mode");
    const modelConfigId = snapshotModels(snapshot).configId;
    const effort = effortControl(options);
    return (
      <>
        <SessionModelPicker
          chatId={chatId}
          snapshot={snapshot}
          cwd={cwd}
          allowSwitch={Boolean(cwd) && !botIdOfChat(chatId)}
          onSelectModel={(modelId) => {
            const config = options.find((option) => option.configId === modelConfigId);
            if (config) selectConfig(config, modelId);
            else selectModel(modelId);
          }}
          onSelectEffort={(value) => { if (effort) selectConfig(effort.option, value); }}
          footer={modeSelect ?? (selectableConfigOptions(modeConfig, new Set()).length > 0 ? configSelect(modeConfig) : null)}
        />
        {configSelect(options.filter((option) => !isPickerManagedOption(option)))}
        <PermissionPolicyDropdown
          kinds={autoApproveKinds}
          onChange={(kinds) => {
            // 同时落为引擎偏好（下次启动沿用）并对当前会话立即生效。
            saveAutoApproveKinds(snapshot.engineId, kinds);
            void agentChatService.setAutoApprove(chatId, kinds).catch(pushError);
          }}
        />
      </>
    );
  }

  return (
    <>
      {modelItems.length > 0 ? (
        <HeaderSelect
          icon={<Cpu className="h-3.5 w-3.5 shrink-0 opacity-70" />}
          items={modelItems}
          currentId={recoverySelections.model ?? snapshot.models?.currentModelId}
          onSelect={selectModel}
        />
      ) : null}
      {modeSelect}
      {configSelect(snapshot.configOptions?.map((option) => ({
        ...option, currentValue: recoverySelections[`config:${option.configId}`] ?? option.currentValue,
      })))}
    </>
  );
}
