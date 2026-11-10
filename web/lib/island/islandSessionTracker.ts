// 灵动岛会话追踪：把主窗口 store 里的「当前状态」折叠成岛要的三组（需要你 / 运行中 / 刚完成）。
//
// 状态 store 只有「现在是什么」，岛还要「从什么时候开始」与「刚刚结束了」：
// 这里按状态跃迁记 runningSince / waitingSince，并在 活跃 → 空闲（或会话消失）时
// 记一条完成记录，保留 DONE_TTL_MS。纯内存、无定时器——每次 store 变化重算一次。
import type { IslandApproval, IslandSession, IslandSessionKind } from "@/types/island";

export const DONE_TTL_MS = 10 * 60_000;

export type SourceActivity = "needs" | "running" | "idle";

/** 一个可被岛展示的会话的当前投影（由事件桥从 store 采集）。 */
export interface IslandSource {
  id: string;
  kind: IslandSessionKind;
  name: string;
  cli: string;
  activity: SourceActivity;
  /** 正在做的事（工具摘要），没有就 null。 */
  detail: string | null;
  approval: IslandApproval | null;
  /** 完成时用作摘要（如最后一条回复 / 完成通知正文）。 */
  summary?: string | null;
}

interface FinishedRecord {
  session: IslandSession;
}

interface TrackedMeta {
  name: string;
  cli: string;
  kind: IslandSessionKind;
  activity: SourceActivity;
  detail: string | null;
}

export class IslandSessionTracker {
  private runningSince = new Map<string, number>();
  private waitingSince = new Map<string, number>();
  private finished = new Map<string, FinishedRecord>();
  private last = new Map<string, TrackedMeta>();

  /** 用户在岛上点开了某个刚完成的会话：从「刚完成」里移除。 */
  dismiss(id: string): void {
    this.finished.delete(id);
  }

  update(sources: readonly IslandSource[], now: number): IslandSession[] {
    const seen = new Set<string>();
    const live: IslandSession[] = [];
    for (const source of sources) {
      seen.add(source.id);
      const session = this.track(source, now);
      if (session) live.push(session);
    }
    // 活跃中途消失（退出 / 被关）的会话也算完成，用最后一次见到的名字。
    for (const [id, meta] of this.last) {
      if (seen.has(id)) continue;
      if (meta.activity !== "idle") this.recordFinish(id, meta, meta.detail, now);
      this.forget(id);
    }
    for (const [id, record] of this.finished) {
      if (now - record.session.since > DONE_TTL_MS) this.finished.delete(id);
    }
    return [...live, ...[...this.finished.values()].map((record) => record.session)];
  }

  private track(source: IslandSource, now: number): IslandSession | null {
    const previous = this.last.get(source.id);
    this.last.set(source.id, {
      name: source.name,
      cli: source.cli,
      kind: source.kind,
      activity: source.activity,
      // 完成时摘要回退到最后一次见到的工具摘要。
      detail: source.detail ?? previous?.detail ?? null,
    });
    if (source.activity === "idle") {
      if (previous && previous.activity !== "idle") {
        this.recordFinish(source.id, previous, source.summary ?? previous.detail, now);
      }
      this.runningSince.delete(source.id);
      this.waitingSince.delete(source.id);
      return null;
    }
    this.finished.delete(source.id);
    if (!this.runningSince.has(source.id)) this.runningSince.set(source.id, now);
    if (source.activity === "running") this.waitingSince.delete(source.id);
    if (source.activity === "needs" && !this.waitingSince.has(source.id)) {
      this.waitingSince.set(source.id, now);
    }
    const since = source.activity === "needs"
      ? this.waitingSince.get(source.id) ?? now
      : this.runningSince.get(source.id) ?? now;
    return {
      id: source.id,
      kind: source.kind,
      name: source.name,
      cli: source.cli,
      state: source.activity,
      activity: source.detail,
      since,
      approval: source.activity === "needs" ? source.approval : null,
    };
  }

  private recordFinish(id: string, meta: TrackedMeta, summary: string | null, now: number): void {
    this.finished.set(id, {
      session: {
        id,
        kind: meta.kind,
        name: meta.name,
        cli: meta.cli,
        state: "done",
        activity: summary,
        since: now,
        approval: null,
      },
    });
  }

  private forget(id: string): void {
    this.last.delete(id);
    this.runningSince.delete(id);
    this.waitingSince.delete(id);
  }
}
