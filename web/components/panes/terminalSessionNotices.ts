import { toast } from "sonner";

/**
 * 会话被另一个 CC-Panes 实例持有写权限时提示用户（docs/61 阶段 2）。
 *
 * 按会话去重 + 冷却：否则用户每敲一个字符都会弹一次 toast。
 * 冷却窗口取 30s，与 daemon 侧租约 TTL 一致——租约过期后本实例可能重新拿到
 * 写权限，那时再提示才有意义。
 */
const sessionClaimedNotifiedAt = new Map<string, number>();
const SESSION_CLAIMED_NOTICE_COOLDOWN_MS = 30_000;

export function notifySessionClaimed(sessionId: string, message: string) {
  const now = Date.now();
  const last = sessionClaimedNotifiedAt.get(sessionId) ?? 0;
  if (now - last < SESSION_CLAIMED_NOTICE_COOLDOWN_MS) return;
  sessionClaimedNotifiedAt.set(sessionId, now);
  toast.warning(message);
}

/** 仅供测试：清空冷却表，避免跨用例互相压制。 */
export function __resetSessionClaimedNoticesForTest() {
  sessionClaimedNotifiedAt.clear();
}
