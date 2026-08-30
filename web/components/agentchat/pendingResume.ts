// 侧栏「最近 Agent 会话」→ 新标签自动续接的一次性交接。
// 模块级 Map 按 tabId 暂存续接意图；EnginePicker 挂载时领取并自动 start。
// 不进 store：这是跨组件的一次性指令，不是需要持久/回放的状态。

export interface PendingResumeEntry {
  engineId: string;
  cwd: string;
  acpSessionId: string;
}

const pending = new Map<string, PendingResumeEntry>();

export function setPendingResume(tabId: string, entry: PendingResumeEntry): void {
  pending.set(tabId, entry);
}

export function takePendingResume(tabId: string): PendingResumeEntry | null {
  const entry = pending.get(tabId) ?? null;
  pending.delete(tabId);
  return entry;
}
