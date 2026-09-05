// 五档断点定义：与 Tailwind 默认断点（sm/md/lg/xl/2xl 中的前五档）对齐，
// 保证 JS 逻辑判断与 class 断点（sm: md: lg: xl:）永不漂移。
// 走查要求见 docs/responsive-breakpoints.md。

export const BREAKPOINTS = {
  xs: 0,
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
} as const;

export type Breakpoint = keyof typeof BREAKPOINTS;

export const BREAKPOINT_ORDER: readonly Breakpoint[] = ["xs", "sm", "md", "lg", "xl"];

export function getBreakpoint(width: number): Breakpoint {
  let current: Breakpoint = "xs";
  for (const bp of BREAKPOINT_ORDER) {
    if (width >= BREAKPOINTS[bp]) current = bp;
  }
  return current;
}

export function isAtLeast(width: number, bp: Breakpoint): boolean {
  return width >= BREAKPOINTS[bp];
}

export function isBelow(width: number, bp: Breakpoint): boolean {
  return width < BREAKPOINTS[bp];
}

/** 当前宽度处于 bp 档、且未进入下一档（xl 的下一档视为无穷大）。 */
export function isExactly(width: number, bp: Breakpoint): boolean {
  const idx = BREAKPOINT_ORDER.indexOf(bp);
  const next = BREAKPOINT_ORDER[idx + 1];
  return width >= BREAKPOINTS[bp] && (next === undefined || width < BREAKPOINTS[next]);
}
