import { agentChatService, type AcpRemoteLaunch } from "@/services/agentChatService";
import i18n from "@/i18n";
import { submitReservedPrompt } from "./submitReservedPrompt";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import type { AcpChatSnapshot, AcpContentBlock, AgentChatAttachment } from "@/types/agentChat";
import { buildPromptBlocks } from "./chatPrompt";
import type { LocalWorktreeDraft } from "@/types/localLaunch";
import { prepareLocalSessionCwd } from "@/services/localLaunchService";
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
  /** 首条消息的附件（启动页 chip），与 firstPrompt 同一条 prompt 发出。 */
  firstAttachments?: AgentChatAttachment[];
  preamble?: string;
  onCwdAdopted?: (cwd: string) => void;
  worktree?: LocalWorktreeDraft;
  /** 远程启动：cwd 是远端目录，不建本地 worktree，也不回写本地 cwd 覆盖。 */
  remote?: AcpRemoteLaunch;
  /** 新会话就绪且偏好已应用、释放输入锁之前调用（换引擎交接在此插分隔线）。 */
  onStarted?: (snapshot: AcpChatSnapshot) => void | Promise<void>;
  /** 运行配置 id（"" = 明确用系统默认；undefined = 新会话系统默认 / 续接沿用会话原配置）。 */
  launchProfileId?: string;
}

async function applyPreferredSelection(
  chatId: string, snapshot: AcpChatSnapshot, category: "mode" | "model", value?: string | null,
): Promise<boolean> {
  if (!value) return false;
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
    if (config.currentValue === value) return false;
    await agentChatService.setConfigOption(chatId, config.configId, value);
  } else if (category === "mode" && snapshot.modes?.currentModeId !== value) {
    await agentChatService.setMode(chatId, value);
  } else if (category === "model" && snapshot.models?.currentModelId !== value) {
    await agentChatService.setModel(chatId, value);
  } else return false;
  return true;
}

async function applyPreferences(chatId: string, snapshot: AcpChatSnapshot): Promise<void> {
  const engineId = snapshot.engineId;
  // 必须在刷新广告缓存前读取偏好：saveEngineModes 会移除不在新列表中的值。
  const prefs = loadEnginePrefs(engineId);
  const modeChanged = await applyPreferredSelection(chatId, snapshot, "mode", prefs?.preferredModeId);
  const modelChanged = await applyPreferredSelection(chatId, snapshot, "model", prefs?.preferredModelId);
  if (engineId === "codex-app-server" && (modeChanged || modelChanged)) {
    // Model changes replace the advertised effort choices. Read the authoritative
    // snapshot after the setter; the state event may still be queued in the WebView.
    const latest = await agentChatService.get(chatId);
    if (!latest || latest.engineId !== engineId || latest.acpSessionId !== snapshot.acpSessionId) {
      throw new Error("Codex configuration changed before preferences could be applied");
    }
    snapshot = latest;
    useAgentChatStore.getState().setSnapshot(chatId, snapshot);
  }
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

/** 启动页附件在会话能力未知时摄取；引擎不收内嵌图片时，有路径的图片退回文件引用
 * （与会话内输入区 planPathAttachment 同口径），避免整条首消息被拒。 */
function firstAttachmentsFor(snapshot: AcpChatSnapshot, attachments?: AgentChatAttachment[]): AgentChatAttachment[] {
  if (!attachments?.length) return [];
  const caps = snapshot.agentCapabilities as { promptCapabilities?: { image?: boolean } } | undefined;
  if (caps?.promptCapabilities?.image === true) return attachments;
  return attachments.map((attachment) => attachment.kind === "image" && attachment.path
    ? { name: attachment.name, mimeType: "", data: "", kind: "file", path: attachment.path }
    : attachment);
}

/** 全局操作锁覆盖 IPC state 提前 ready 和组件卸载；配置失败保持输入禁用，可重试启动。 */
export async function startConfiguredChat(options: StartConfiguredChatOptions): Promise<AcpChatSnapshot | null> {
  const { chatId, engineId, cwd, firstPrompt, firstAttachments, preamble } = options;
  const store = useAgentChatStore.getState();
  const token = store.beginSetup(chatId, { firstPrompt, firstAttachments, preamble });
  if (token === null) return null;
  const ownsSetup = () => useAgentChatStore.getState().chats[chatId]?.setup?.token === token;
  let spawnAttempted = false;
  try {
    if (options.resumeAcpSessionId && options.worktree?.enabled) {
      throw new Error(i18n.t("worktreeNewSessionOnly", { ns: "launcher" }));
    }
    if (options.remote && options.worktree?.enabled) {
      throw new Error(i18n.t("worktreeUnavailableRemote", { ns: "launcher" }));
    }
    const launchCwd = options.remote ? cwd : await prepareLocalSessionCwd(cwd, options.worktree);
    if (!ownsSetup()) return null;
    // Adopt a successfully created worktree before spawn, so a failed engine can retry there.
    if (launchCwd !== cwd) {
      store.setCwdOverride(chatId, launchCwd);
      options.onCwdAdopted?.(launchCwd);
    }
    spawnAttempted = true;
    const autoApprove = options.autoApproveKinds ?? loadAutoApproveKinds(engineId);
    const snapshot = options.launchProfileId !== undefined
      ? await agentChatService.start(chatId, engineId, launchCwd, options.resumeAcpSessionId, autoApprove, options.remote,
        { launchProfileId: options.launchProfileId })
      : options.remote
        ? await agentChatService.start(chatId, engineId, launchCwd, options.resumeAcpSessionId, autoApprove, options.remote)
        : await agentChatService.start(chatId, engineId, launchCwd, options.resumeAcpSessionId, autoApprove);
    if (!ownsSetup()) return null;
    store.setSnapshot(chatId, snapshot);
    // 「Codex」原生 App Server 起不来、后端自动改走 ACP 桥：一行提示，不打断启动。
    if (snapshot.transportFallback) store.pushNotice(chatId, i18n.t("agentChatCodexAcpFallback", { ns: "panes" }));
    if (!options.remote) options.onCwdAdopted?.(launchCwd);
    await applyPreferences(chatId, snapshot);
    if (!ownsSetup()) return null;
    await options.onStarted?.(snapshot);
    if (!ownsSetup()) return null;
    const text = firstPrompt?.trim() ?? "";
    const attachments = firstAttachmentsFor(snapshot, firstAttachments);
    if (text || attachments.length > 0) {
      const lead = preamble?.trim();
      const outbound = lead && text ? `${lead}\n\n---\n\n${text}` : lead || text;
      const blocks: AcpContentBlock[] = [
        ...buildPromptBlocks("", attachments, launchCwd),
        ...(outbound ? [{ type: "text", text: outbound }] : []),
      ];
      const submission = store.beginPrompt(chatId, { text, attachments, promptBlocks: blocks }, token);
      if (submission === null) throw new Error("Agent chat is busy accepting another prompt");
      await submitReservedPrompt(chatId, submission, blocks);
    }
    store.finishSetup(chatId, token);
    return snapshot;
  } catch (error) {
    if (ownsSetup()) {
      const message = error instanceof Error ? error.message : String(error);
      // Keep launch settings available after preparation failure; retry must not silently
      // start in the source checkout without the requested worktree.
      if (spawnAttempted) {
        if (!useAgentChatStore.getState().chats[chatId]?.snapshot) {
          store.setSnapshot(chatId, { chatId, engineId, phase: "failed", error: message });
        } else {
          const items = useAgentChatStore.getState().chats[chatId]?.items ?? [];
          const last = items[items.length - 1];
          if (last?.type !== "notice" || last.text !== message) store.pushNotice(chatId, message);
        }
      }
      store.finishSetup(chatId, token, message);
    }
    throw error;
  }
}
