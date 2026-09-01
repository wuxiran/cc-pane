/**
 * JSON 取值辅助：ArkTS 严格模式下 JSON.parse 结果需显式类型收窄。
 * 所有函数对缺字段/类型不符返回 fallback 或 undefined，不抛异常（对齐 Dart fromJson 的 `as T? ?? 默认值` 语义）。
 */

export function asRecord(v: Object | undefined | null): Record<string, Object> | undefined {
  if (v === null || v === undefined) {
    return undefined;
  }
  if (typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, Object>;
  }
  return undefined;
}

export function asArray(v: Object | undefined | null): Object[] | undefined {
  if (v === null || v === undefined) {
    return undefined;
  }
  if (Array.isArray(v)) {
    return v as Object[];
  }
  return undefined;
}

export function jsonGetString(rec: Record<string, Object>, key: string, fallback: string): string {
  let v: Object | undefined = rec[key];
  return typeof v === 'string' ? v as string : fallback;
}

/** 字段为字符串时返回原值（可为空串）；缺失或非字符串返回 undefined。 */
export function jsonGetStringOpt(rec: Record<string, Object>, key: string): string | undefined {
  let v: Object | undefined = rec[key];
  return typeof v === 'string' ? v as string : undefined;
}

export function jsonGetNumber(rec: Record<string, Object>, key: string, fallback: number): number {
  let v: Object | undefined = rec[key];
  return typeof v === 'number' ? v as number : fallback;
}

export function jsonGetNumberOpt(rec: Record<string, Object>, key: string): number | undefined {
  let v: Object | undefined = rec[key];
  return typeof v === 'number' ? v as number : undefined;
}

export function jsonGetBool(rec: Record<string, Object>, key: string, fallback: boolean): boolean {
  let v: Object | undefined = rec[key];
  return typeof v === 'boolean' ? v as boolean : fallback;
}

export function jsonGetRecord(rec: Record<string, Object>, key: string): Record<string, Object> | undefined {
  let v: Object | undefined = rec[key];
  return asRecord(v);
}

/** 取数组字段，逐项过滤为对象（对齐 Dart `.whereType<Map<String, dynamic>>()`）。 */
export function jsonGetRecords(rec: Record<string, Object>, key: string): Record<string, Object>[] {
  let v: Object | undefined = rec[key];
  let arr: Object[] | undefined = asArray(v);
  let out: Record<string, Object>[] = [];
  if (arr === undefined) {
    return out;
  }
  for (let item of arr) {
    let converted: Record<string, Object> | undefined = asRecord(item);
    if (converted !== undefined) {
      out.push(converted);
    }
  }
  return out;
}
