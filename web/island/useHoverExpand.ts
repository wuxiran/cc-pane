import { useCallback, useEffect, useRef, useState } from "react";

export const COLLAPSE_DELAY_MS = 600;

/** 指针进入岛即展开；离开 600ms 后收起（期间回来则取消）。 */
export function useHoverExpand() {
  const [hovered, setHovered] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const onPointerEnter = useCallback(() => {
    cancel();
    setHovered(true);
  }, []);

  const onPointerLeave = useCallback(() => {
    cancel();
    timer.current = setTimeout(() => {
      timer.current = null;
      setHovered(false);
    }, COLLAPSE_DELAY_MS);
  }, []);

  useEffect(() => cancel, []);

  return { hovered, onPointerEnter, onPointerLeave };
}
