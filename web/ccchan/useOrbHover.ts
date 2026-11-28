// 任务球的悬停时序：悬停球 openDelay 展开、离开球与列表 closeDelay 收起、
// 悬停某行 dwellSwitch 自动切换。时序常量见 orbModel.ts 的 ORB_TIMINGS。
//
// `hovered` 是「光标在球或列表上」的并集（后端命中测试 + DOM 兜底），
// 行悬停由调用方喂进来（原生光标坐标或 DOM pointerenter，两路幂等）。
import { useCallback, useEffect, useRef, useState } from "react";
import { ORB_TIMINGS } from "./orbModel";

export interface OrbHoverOptions {
  hovered: boolean;
  /** 拖动中不展开。 */
  dragging: boolean;
  /** 「悬停即切换」开关。 */
  hoverSwitch: boolean;
  onDwell: (sessionId: string) => void;
}

export interface OrbHoverState {
  open: boolean;
  highlight: number;
  /** 正在计时的行（行底进度条走满）。 */
  dwellId: string | null;
  openNow: () => void;
  close: () => void;
  setHighlight: (index: number) => void;
  rowEnter: (sessionId: string, index: number) => void;
  rowLeave: () => void;
}

type Timer = ReturnType<typeof setTimeout>;

export function useOrbHover({ hovered, dragging, hoverSwitch, onDwell }: OrbHoverOptions): OrbHoverState {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [dwellId, setDwellId] = useState<string | null>(null);
  // 收起后光标仍停在球上（单击切换 / 悬停切换后）不能立刻重开：要先离开再回来。
  const [rearmNeeded, setRearmNeeded] = useState(false);
  const dwellTimer = useRef<Timer | null>(null);
  const dwellRef = useRef<string | null>(null);
  const onDwellRef = useRef(onDwell);
  onDwellRef.current = onDwell;

  const cancelDwell = useCallback(() => {
    if (dwellTimer.current) clearTimeout(dwellTimer.current);
    dwellTimer.current = null;
    dwellRef.current = null;
    setDwellId(null);
  }, []);

  const close = useCallback(() => {
    cancelDwell();
    setOpen(false);
    setRearmNeeded(true);
  }, [cancelDwell]);

  useEffect(() => {
    if (!hovered && rearmNeeded) setRearmNeeded(false);
  }, [hovered, rearmNeeded]);

  const openNow = useCallback(() => {
    setHighlight(0);
    setOpen(true);
  }, []);

  // 悬停球 → 延迟展开；拖动中 / 已展开不再计时。
  useEffect(() => {
    if (!hovered || open || dragging || rearmNeeded) return;
    const timer = setTimeout(openNow, ORB_TIMINGS.openDelayMs);
    return () => clearTimeout(timer);
  }, [dragging, hovered, open, openNow, rearmNeeded]);

  // 离开球和列表 → 延迟收起（跨过两者之间的间隙不会关）。
  useEffect(() => {
    if (hovered || !open) return;
    const timer = setTimeout(close, ORB_TIMINGS.closeDelayMs);
    return () => clearTimeout(timer);
  }, [close, hovered, open]);

  useEffect(() => {
    if (!hoverSwitch) cancelDwell();
  }, [cancelDwell, hoverSwitch]);

  useEffect(() => () => {
    if (dwellTimer.current) clearTimeout(dwellTimer.current);
  }, []);

  const rowEnter = useCallback((sessionId: string, index: number) => {
    if (dwellRef.current === sessionId) return;
    cancelDwell();
    setHighlight(index);
    if (!hoverSwitch) return;
    dwellRef.current = sessionId;
    setDwellId(sessionId);
    dwellTimer.current = setTimeout(() => {
      dwellTimer.current = null;
      dwellRef.current = null;
      setDwellId(null);
      setOpen(false);
      setRearmNeeded(true);
      onDwellRef.current(sessionId);
    }, ORB_TIMINGS.dwellSwitchMs);
  }, [cancelDwell, hoverSwitch]);

  return { open, highlight, dwellId, openNow, close, setHighlight, rowEnter, rowLeave: cancelDwell };
}
