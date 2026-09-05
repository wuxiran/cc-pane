import { useEffect, useState } from "react";
import { BREAKPOINT_ORDER, getBreakpoint, type Breakpoint } from "@/lib/breakpoints";

function currentWidth() {
  return typeof window === "undefined" ? 0 : window.innerWidth;
}

/** 订阅窗口宽度所属的五档断点（xs/sm/md/lg/xl），窗口 resize 时更新。 */
export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(() => getBreakpoint(currentWidth()));

  useEffect(() => {
    const onResize = () => {
      const next = getBreakpoint(currentWidth());
      setBp((prev) => (prev === next ? prev : next));
    };
    window.addEventListener("resize", onResize);
    onResize();
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return bp;
}

/** 窗口宽度是否达到给定断点（含），语义等价于 Tailwind 的 `<bp>:` 前缀。 */
export function useMediaUp(bp: Breakpoint): boolean {
  const current = useBreakpoint();
  return BREAKPOINT_ORDER.indexOf(current) >= BREAKPOINT_ORDER.indexOf(bp);
}
