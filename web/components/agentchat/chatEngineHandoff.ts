// 换引擎「上下文交接」流程：同一 chatId 上用新引擎重开会话，对话不中断。
//
// - 旧条目不清空：后端 start 的 replace 语义只停旧进程；前端 setSnapshot 在新
//   acpSessionId ready 时把 transcriptStart 推到末尾，旧条目成为只读前缀。
// - 交接分隔线插在前缀末尾；交接上下文（确定性摘要）挂在 store 上，等切换后
//   的第一条用户消息作为前置 text block 发出（submitReservedPrompt）。
// - 持久化：前缀（含分隔线）作为新会话转写的继承段落盘，引擎序列写进历史 meta。
import i18n from "@/i18n";
import { agentChatService } from "@/services/agentChatService";
import { sanitizeTranscriptItems } from "@/stores/agentChatTranscript";
import { getAgentChatRemoteTarget } from "@/stores/useAgentChatRemoteStore";
import { useAgentChatStore, type AgentChatSessionState } from "@/stores/useAgentChatStore";
import { chatEngineTrail, type HandoffNotice } from "@/stores/useAgentChatStoreHandoff";
import type { AcpChatSnapshot, AcpEngineInfo } from "@/types/agentChat";
import { handleErrorSilent } from "@/utils/errorHandler";
import { codexEngineLabel } from "@/lib/codexIntegration";
import { buildHandoffSummary } from "./chatHandoffSummary";
import { remoteLaunchOf } from "./remoteTarget";
import { startConfiguredChat } from "./startConfiguredChat";

/** 当前模型的展示名：configOptions 的 model 类别优先，其次 legacy models。 */
export function snapshotModelLabel(snapshot: AcpChatSnapshot | null | undefined): string | null {
  if (!snapshot) return null;
  const config = snapshot.configOptions?.find((option) => option.category === "model");
  if (config && config.currentValue !== undefined && config.currentValue !== null) {
    const choice = config.options?.find((option) => option.value === config.currentValue);
    return choice?.name || String(config.currentValue) || null;
  }
  const modelId = snapshot.models?.currentModelId;
  if (!modelId) return null;
  return snapshot.models?.availableModels?.find((model) => model.modelId === modelId)?.name || modelId;
}

/** 「引擎 · 模型」；模型未知时只有引擎名。 */
export function engineSideLabel(engineLabel: string, snapshot: AcpChatSnapshot | null | undefined): string {
  const model = snapshotModelLabel(snapshot);
  return model && model !== engineLabel ? `${engineLabel} · ${model}` : engineLabel;
}

/** 生成中、有待处理权限/提问、正在启动或提交时不能切换。 */
export function canSwitchEngine(chat: AgentChatSessionState | undefined): boolean {
  return Boolean(chat?.snapshot && chat.snapshot.phase === "ready" && !chat.setup?.pending && !chat.setup?.error
    && !chat.pendingPrompt && chat.pendingPermissions.length === 0 && chat.pendingElicitations.length === 0);
}

/**
 * 可切换的目标：可用、不是当前引擎。远程会话也保留「Codex」（codex-app-server）：原生
 * App Server 只在本机跑，后端会对远程会话自动改走 ACP 兼容模式。`remote` 参数保留给调用方。
 */
export function handoffTargets(engines: readonly AcpEngineInfo[], currentEngineId: string | undefined, _remote: boolean): AcpEngineInfo[] {
  return engines.filter((engine) => engine.available && engine.id !== currentEngineId);
}

export interface SwitchChatEngineOptions {
  chatId: string;
  target: AcpEngineInfo;
  /** 当前引擎的展示名（来自引擎列表；缺省按 id 推）。 */
  currentEngineLabel?: string;
  cwd: string;
}

/** 执行交接；未能开始（忙/锁被占）返回 false，启动失败抛错（错误已入消息流）。 */
export async function switchChatEngine({ chatId, target, currentEngineLabel, cwd }: SwitchChatEngineOptions): Promise<boolean> {
  const chat = useAgentChatStore.getState().chats[chatId];
  const from = chat?.snapshot;
  if (!chat || !from || !canSwitchEngine(chat) || from.engineId === target.id || !cwd) return false;
  const fromEngineId = from.engineId;
  const fromLabel = engineSideLabel(currentEngineLabel || codexEngineLabel(fromEngineId), from);
  // 摘要基于切换前的全部条目（含更早的只读前缀与之前的交接）。
  const sourceItems = chat.items;
  const trailBefore = chatEngineTrail(chat);
  const remote = getAgentChatRemoteTarget(chatId);
  const started = await startConfiguredChat({
    chatId,
    engineId: target.id,
    cwd: remote?.cwd || cwd,
    remote: remoteLaunchOf(remote),
    onStarted: async (snapshot) => {
      const latest = useAgentChatStore.getState().chats[chatId]?.snapshot ?? snapshot;
      const toLabel = engineSideLabel(target.label || codexEngineLabel(target.id), latest);
      const id = `handoff-${snapshot.acpSessionId ?? Date.now().toString(36)}`;
      const notice: HandoffNotice = {
        type: "notice",
        id,
        at: Date.now(),
        text: i18n.t("agentChatHandoffNotice", { ns: "panes", from: fromLabel, to: toLabel }),
        handoff: { from: fromLabel, to: toLabel, fromEngineId, toEngineId: target.id },
      };
      const engineTrail = trailBefore[trailBefore.length - 1] === target.id ? trailBefore : [...trailBefore, target.id];
      useAgentChatStore.getState().recordHandoff(chatId, {
        notice,
        context: buildHandoffSummary(sourceItems, { fromLabel, toLabel }),
        engineTrail,
      });
      const after = useAgentChatStore.getState().chats[chatId];
      if (!snapshot.acpSessionId || !after) return;
      // 继承段落盘失败不阻断交接：画面与待发送的上下文都已就位。
      await agentChatService.saveTranscript(
        snapshot.acpSessionId,
        sanitizeTranscriptItems(after.items.slice(after.transcriptStart)),
        { inherited: sanitizeTranscriptItems(after.items.slice(0, after.transcriptStart)), engines: engineTrail },
      ).catch((error) => handleErrorSilent(error, "save agent chat handoff transcript"));
    },
  });
  return started !== null;
}
