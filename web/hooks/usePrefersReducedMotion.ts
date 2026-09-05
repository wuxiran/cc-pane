// 系统「减弱动态效果」开关订阅。
// 用途：签名动效（视图切入视差滑动）在 reduced-motion 下退回纯 fade——
// index.css 的全局规则只能收短 CSS 声明的过渡/keyframe，管不到组件内联的
// rAF 驱动动画，所以 JS 侧需要自己读这个开关。
// jsdom / 旧 WebView 没有 matchMedia：按 false（全动效）处理，与
// wallpaperVideoPolicy.ts 的 guard 同一惯例。
import { useEffect, useState } from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function queryList(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(REDUCED_MOTION_QUERY);
}

/** 用户是否开启了「减弱动态效果」。缺 matchMedia 的环境恒为 false。 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => queryList()?.matches ?? false);

  useEffect(() => {
    const mql = queryList();
    if (!mql) return;
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    setReduced(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return reduced;
}
