import { agentChatService } from "@/services/agentChatService";
import i18n from "@/i18n";
import { submitReservedPrompt } from "./submitReservedPrompt";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import type { AcpChatSnapshot } from "@/types/agentChat";
import {
  loadAutoApproveKinds, loadEnginePrefs, loadPreferredConfigOptions,
  saveEngineModels, saveEngineModes,
} from "./enginePrefs";

interface StartConfiguredChatOptions {
  chatId: string;
  engineId: string;
  cwd: string;
  resumeAcpSessionId?: string;
  autoApproveKinds?: string[];
  firstPrompt?: string;
  preamble?: string;
  onCwdAdopted?: (cwd: string) => void;
}

async function applyPreferredSelection(
  chatId: string, snapshot: AcpChatSnapshot, category: "mode" | "model", value?: string | null,
): Promise<void> {
  if (!value) return;
  const config = snapshot.configOptions?.find((option) => option.category === category);
  // 新版适配器可能只广告 configOptions，不提供 legacy modes/set_mode。
  // 用户选择来自缓存时仍须以本次广告为准，不能把不可用的限制模式静默抹掉。
  const available = config
    ? (config.options ?? []).some((choice) => choice.value === value)
    : category === "mode"
      ? (snapshot.modes?.availableModes ?? []).some((item) => item.id === value)
      : (snapshot.models?.availableModels ?? []).some((item) => item.modelId === value);
  if (!available) {
    throw new Error(i18n.t(category === "mode" ? "agentChatModeUnavailable" : "agentChatModelUnavailable", { ns: "panes", mode: value, model: value }));
  }
  if (config) {
    if (config.currentValue !== value) await agentChatService.setConfigOption(chatId, config.configId, value);
  } else if (category === "mode" && snapshot.modes?.currentModeId !== value) {
    await agentChatService.setMode(chatId, value);
  } else if (category === "model" && snapshot.models?.currentModelId !== value) {
    await agentChatService.setModel(chatId, value);
  }
}

async function applyPreferences(chatId: string, snapshot: AcpChatSnapshot): Promise<void> {
  const engineId = snapshot.engineId;
  // 必须在刷新广告缓存前读取偏好：saveEngineModes 会移除不在新列表中的值。
  const prefs = loadEnginePrefs(engineId);
  await applyPreferredSelection(chatId, snapshot, "mode", prefs?.preferredModeId);
  await applyPreferredSelection(chatId, snapshot, "model", prefs?.preferredModelId);
  const modelConfig = snapshot.configOptions?.find((option) => option.category === "model");
  const models = modelConfig?.options?.map((choice) => ({ modelId: choice.value, name: choice.name, description: choice.description }))
    ?? snapshot.models?.availableModels ?? [];
  const modeConfig = snapshot.configOptions?.find((option) => option.category === "mode");
  const modes = modeConfig?.options?.map((choice) => ({ id: choice.value, name: choice.name, description: choice.description }))
    ?? snapshot.modes?.availableModes
    ?? [];
  saveEngineModels(engineId, models);
  saveEngineModes(engineId, modes);
  const preferredOptions = loadPreferredConfigOptions(engineId);
  for (const option of snapshot.configOptions ?? []) {
    const wanted = preferredOptions[option.configId];
    if (wanted === undefined || option.category === "mode" || option.category === "model"
      || option.currentValue === wanted || !(option.options ?? []).some((choice) => choice.value === wanted)) continue;
    await agentChatService.setConfigOption(chatId, option.configId, wanted);
  }
}

/** 全局操作锁覆盖 IPC state 提前 ready 和组件卸载；配置失败保持输入禁用，可重试启动。 */
export async function startConfiguredChat(options: StartConfiguredChatOptions): Promise<AcpChatSnapshot | null> {
  const { chatId, engineId, cwd, firstPrompt, preamble } = options;
  const store = useAgentChatStore.getState();
  const token = store.beginSetup(chatId, { firstPrompt, preamble });
  if (token === null) return null;
  const ownsSetup = () => useAgentChatStore.getState().chats[chatId]?.setup?.token === token;
  try {
    const snapshot = await agentChatService.start(
      chatId, engineId, cwd, options.resumeAcpSessionId,
      options.autoApproveKinds ?? loadAutoApproveKinds(engineId),
    );
    if (!ownsSetup()) return null;
    store.setSnapshot(chatId, snapshot);
    options.onCwdAdopted?.(cwd);
    await applyPreferences(chatId, snapshot);
    if (!ownsSetup()) return null;
    const text = firstPrompt?.trim();
    if (text) {
      const lead = preamble?.trim();
      const outbound = lead ? `${lead}\n\n---\n\n${text}` : text;
      const blocks = [{ type: "text", text: outbound }];
      const submission = store.beginPrompt(chatId, { text, attachments: [], promptBlocks: blocks }, token);
      if (submission === null) throw new Error("Agent chat is busy accepting another prompt");
      await submitReservedPrompt(chatId, submission, blocks);
    }
    store.finishSetup(chatId, token);
    return snapshot;
  } catch (error) {
    if (ownsSetup()) {
      const message = error instanceof Error ? error.message : String(error);
      if (!useAgentChatStore.getState().chats[chatId]?.snapshot) {
        store.setSnapshot(chatId, { chatId, engineId, phase: "failed", error: message });
      } else {
        const items = useAgentChatStore.getState().chats[chatId]?.items ?? [];
        const last = items[items.length - 1];
        if (last?.type !== "notice" || last.text !== message) store.pushNotice(chatId, message);
      }
      store.finishSetup(chatId, token, message);
    }
    throw error;
  }
}
