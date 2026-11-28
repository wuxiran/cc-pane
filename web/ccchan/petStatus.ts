// 桌宠状态模型：把每个终端会话和当前 Bot 的对话各映射成一个宠物状态，
// 再按紧急程度聚合成宠物要演的那一个。纯函数，便于测试。
//
// 优先级：needsInput > blocked > ready > running > idle。
// ready = 「完成了但你还没看」：会话从运行中回到空闲那一刻起算，
// 直到主窗口报告你看过它（会话目录里 viewed=true）才清掉。
import type { AcpChatPhase } from "@/types/agentChat";
import type { TerminalStatusInfo, TerminalStatusType } from "@/types";
import type { PetAnimationSpec, PetMeta, SessionDirectoryEntry } from "./types";

export type PetStatus = "idle" | "running" | "needsInput" | "ready" | "blocked";

export const PET_STATUS_PRIORITY: Record<PetStatus, number> = {
  idle: 0,
  running: 1,
  ready: 2,
  blocked: 3,
  needsInput: 4,
};

const WORKING: ReadonlySet<TerminalStatusType> = new Set([
  "initializing",
  "thinking",
  "toolRunning",
  "compacting",
  "active",
]);

export function isWorkingTerminalStatus(status: TerminalStatusType | undefined): boolean {
  return status !== undefined && WORKING.has(status);
}

/** 单个终端会话 → 宠物状态；已退出的会话不参与（返回 null）。 */
export function terminalPetStatus(status: TerminalStatusType, ready: boolean): PetStatus | null {
  if (status === "exited") return null;
  if (status === "waitingInput") return "needsInput";
  if (status === "error") return "blocked";
  if (WORKING.has(status)) return "running";
  return ready ? "ready" : "idle";
}

export interface BotPetState {
  phase: AcpChatPhase | null;
  /** 待处理的审批 / 提问数。 */
  pendingRequests: number;
  /** 最近一轮出错（下一轮开始前一直算 blocked）。 */
  error: boolean;
}

export const IDLE_BOT_STATE: BotPetState = { phase: null, pendingRequests: 0, error: false };

export function botPetStatus(bot: BotPetState): PetStatus {
  if (bot.pendingRequests > 0) return "needsInput";
  if (bot.error || bot.phase === "failed") return "blocked";
  if (bot.phase === "generating" || bot.phase === "starting") return "running";
  return "idle";
}

export function aggregatePetStatus(statuses: Iterable<PetStatus>): PetStatus {
  let best: PetStatus = "idle";
  for (const status of statuses) {
    if (PET_STATUS_PRIORITY[status] > PET_STATUS_PRIORITY[best]) best = status;
  }
  return best;
}

/**
 * ready 集合的推进：运行中 → 空闲 的会话记为「完成未看」；
 * 用户看过、会话消失、或再次进入别的状态时移除。
 */
export function nextReadySet(
  previous: ReadonlyMap<string, TerminalStatusType>,
  current: ReadonlyMap<string, TerminalStatusType>,
  ready: ReadonlySet<string>,
  viewed: ReadonlySet<string>,
): Set<string> {
  const next = new Set<string>();
  for (const [sessionId, status] of current) {
    if (viewed.has(sessionId) || status !== "idle") continue;
    const finished = isWorkingTerminalStatus(previous.get(sessionId));
    if (ready.has(sessionId) || finished) next.add(sessionId);
  }
  return next;
}

export interface SessionPetEntry {
  sessionId: string;
  /** 标签名；主窗口还没推目录时退回会话 id 前 8 位。 */
  title: string;
  status: PetStatus;
  updatedAt: number;
}

export function shortSessionLabel(sessionId: string): string {
  return sessionId.slice(0, 8);
}

/** 会话列表：按紧急程度、再按最近更新排序。 */
export function buildSessionEntries(
  statuses: Iterable<TerminalStatusInfo>,
  ready: ReadonlySet<string>,
  directory: ReadonlyMap<string, SessionDirectoryEntry>,
): SessionPetEntry[] {
  const entries: SessionPetEntry[] = [];
  for (const info of statuses) {
    const status = terminalPetStatus(info.status, ready.has(info.sessionId));
    if (!status) continue;
    const title = directory.get(info.sessionId)?.title?.trim();
    entries.push({
      sessionId: info.sessionId,
      title: title || shortSessionLabel(info.sessionId),
      status,
      updatedAt: info.updatedAt ?? 0,
    });
  }
  return entries.sort(
    (a, b) =>
      PET_STATUS_PRIORITY[b.status] - PET_STATUS_PRIORITY[a.status] || b.updatedAt - a.updatedAt,
  );
}

export type PetClickTarget = { kind: "session"; sessionId: string } | { kind: "ask" };

const URGENT: ReadonlySet<PetStatus> = new Set(["needsInput", "blocked", "ready"]);

/**
 * 左键点宠物：有紧急会话（等输入 / 出错 / 完成未看）就跳过去；
 * Bot 自己更紧急（比如它在等审批）或没有紧急会话时，打开对 Bot 的提问气泡。
 */
export function pickClickTarget(entries: readonly SessionPetEntry[], bot: PetStatus): PetClickTarget {
  const top = entries[0];
  if (!top || !URGENT.has(top.status)) return { kind: "ask" };
  if (PET_STATUS_PRIORITY[bot] > PET_STATUS_PRIORITY[top.status]) return { kind: "ask" };
  return { kind: "session", sessionId: top.sessionId };
}

/**
 * 状态 → 动画查找链。Codex 标准行：idle 0、running 7、needsInput 6、
 * ready 3（挥手）、blocked 5（失败）。旧皮肤键名（working/waiting/happy/sad）同样识别。
 */
export const PET_ANIMATION_CHAIN: Record<PetStatus, readonly string[]> = {
  idle: ["idle"],
  running: ["running", "working", "thinking"],
  needsInput: ["needsInput", "waiting"],
  ready: ["ready", "waving", "happy"],
  blocked: ["blocked", "failed", "sad"],
};

const FALLBACK_ANIMATION: PetAnimationSpec = { row: 0, frames: 1, fps: 1 };

export function resolvePetAnimation(pet: PetMeta, status: PetStatus): PetAnimationSpec {
  for (const key of PET_ANIMATION_CHAIN[status]) {
    const animation = pet.animations[key];
    if (animation) return animation;
  }
  return pet.animations.idle ?? FALLBACK_ANIMATION;
}
