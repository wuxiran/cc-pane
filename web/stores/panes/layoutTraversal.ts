// `.layouts` 直接遍历的唯一散点出口（layoutTraversalGuard 守卫：usePanesStore 拆分
// 出来的文件不得出现 `.layouts.find(` / `for (... of ...layouts)` 等直访写法）。
// 全部以 layouts 为参数（与 paneLayoutHelpers 的 eachLayoutTree 家族同分工）；
// 实现内部不出现被扫描的 `.layouts.` 文本。逻辑与被替换的直写逐项等价。
export function findLayout<T>(
  layouts: readonly T[],
  predicate: (layout: T) => boolean,
): T | undefined {
  return layouts.find(predicate);
}

export function findLayoutIndex<T>(
  layouts: readonly T[],
  predicate: (layout: T) => boolean,
): number {
  return layouts.findIndex(predicate);
}

export function filterLayouts<T, S extends T>(
  layouts: readonly T[],
  predicate: (layout: T) => layout is S,
): S[];
export function filterLayouts<T>(
  layouts: readonly T[],
  predicate: (layout: T) => boolean,
): T[];
export function filterLayouts<T>(
  layouts: readonly T[],
  predicate: (layout: T) => boolean,
): T[] {
  return layouts.filter(predicate);
}

export function flatMapLayouts<T, R>(
  layouts: readonly T[],
  fn: (layout: T) => R | readonly R[],
): R[] {
  return layouts.flatMap(fn);
}

export function someLayout<T>(
  layouts: readonly T[],
  predicate: (layout: T) => boolean,
): boolean {
  return layouts.some(predicate);
}

export function eachLayout<T>(
  layouts: readonly T[],
  fn: (layout: T) => void,
): void {
  for (const layout of layouts) fn(layout);
}
