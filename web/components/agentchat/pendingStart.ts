// 首页「对 agent 说」→ 新标签自动启动并发送首条消息的一次性交接。
// 与 pendingResume 同构：模块级 Map 按 tabId 暂存，EnginePicker 挂载时领取。
// preamble 是发给引擎但不在对话里显示的前置指令（ACP 没有系统提示词字段，
// 管家角色只能随首条 prompt 一起交给 agent）。

export interface PendingStartEntry {
  engineId: string;
  cwd: string;
  firstPrompt: string;
  preamble?: string;
}

const pending = new Map<string, PendingStartEntry>();

export function setPendingStart(tabId: string, entry: PendingStartEntry): void {
  pending.set(tabId, entry);
}

export function takePendingStart(tabId: string): PendingStartEntry | null {
  const entry = pending.get(tabId) ?? null;
  pending.delete(tabId);
  return entry;
}
