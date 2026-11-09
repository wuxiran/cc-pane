/**
 * 布局懒挂载（issue #43）：返回本轮应挂载视图的布局 id 集合。
 *
 * - 初始只含当前布局；切入某布局时加入（首次访问才挂）。
 * - 切走后开始计时，超过 `getLayoutUnmountDelayMs()`（停泊延迟 × 10）且可安全卸载的
 *   布局移出集合（视图卸载，store 状态与 daemon 会话不动）。策略见 layoutMountPolicy.ts。
 *
 * 只管视图挂载：标签/分屏数据始终在 panes store，PTY 会话始终在 daemon。
 */
import { useEffect, useRef, useState } from "react";
import type { LayoutEntry } from "@/types";
import { getLayoutUnmountDelayMs } from "@/components/panes/terminalParkingSettings";
import { planLayoutEviction } from "./layoutMountPolicy";

export interface UseLazyLayoutMountOptions {
  now?: () => number;
  delayMs?: () => number;
}

export function useLazyLayoutMount(
  layouts: readonly LayoutEntry[],
  currentLayoutId: string,
  { now = Date.now, delayMs = getLayoutUnmountDelayMs }: UseLazyLayoutMountOptions = {},
): ReadonlySet<string> {
  const [mounted, setMounted] = useState<ReadonlySet<string>>(() => new Set([currentLayoutId]));
  const hiddenSinceRef = useRef(new Map<string, number>());
  const previousLayoutIdRef = useRef(currentLayoutId);
  const layoutsRef = useRef(layouts);
  layoutsRef.current = layouts;
  // 定时器触发却未到期（时钟漂移 / 阻断项刚出现又消失）时用它强制重排。
  const [recheck, setRecheck] = useState(0);
  const clockRef = useRef({ now, delayMs });
  clockRef.current = { now, delayMs };

  // 切换：新布局入集合并停表，旧布局起表。
  useEffect(() => {
    const previous = previousLayoutIdRef.current;
    previousLayoutIdRef.current = currentLayoutId;
    const hiddenSince = hiddenSinceRef.current;
    hiddenSince.delete(currentLayoutId);
    if (previous !== currentLayoutId) hiddenSince.set(previous, clockRef.current.now());
    setMounted((prev) => {
      if (prev.has(currentLayoutId)) return prev;
      const next = new Set(prev);
      next.add(currentLayoutId);
      return next;
    });
  }, [currentLayoutId]);

  // 已删除的布局：清记录，避免集合与计时表只增不减。
  useEffect(() => {
    const alive = new Set(layouts.map((layout) => layout.id));
    for (const id of hiddenSinceRef.current.keys()) {
      if (!alive.has(id)) hiddenSinceRef.current.delete(id);
    }
    setMounted((prev) => {
      if ([...prev].every((id) => alive.has(id) || id === currentLayoutId)) return prev;
      return new Set([...prev].filter((id) => alive.has(id) || id === currentLayoutId));
    });
  }, [layouts, currentLayoutId]);

  // 到期卸载：每次输入变化重排一个最早到期的定时器；触发时按最新 store 快照复核。
  useEffect(() => {
    // 还没切走过任何布局：无需计时（也不去读设置）。
    if (hiddenSinceRef.current.size === 0) return;
    const evaluate = () => {
      const { now: readNow, delayMs: readDelay } = clockRef.current;
      return planLayoutEviction({
        layouts: layoutsRef.current,
        mounted,
        currentLayoutId,
        hiddenSince: hiddenSinceRef.current,
        now: readNow(),
        delayMs: readDelay(),
      });
    };
    const evict = (expired: string[]) => {
      if (expired.length === 0) return;
      setMounted((prev) => {
        const next = new Set(prev);
        for (const id of expired) next.delete(id);
        return next;
      });
    };
    const plan = evaluate();
    if (plan.expired.length > 0) {
      evict(plan.expired);
      return;
    }
    if (plan.nextDeadline === null) return;
    const wait = Math.max(0, plan.nextDeadline - clockRef.current.now());
    const timer = setTimeout(() => {
      const { expired } = evaluate();
      if (expired.length > 0) evict(expired);
      else setRecheck((value) => value + 1);
    }, wait);
    return () => clearTimeout(timer);
  }, [mounted, currentLayoutId, layouts, recheck]);

  return mounted;
}
