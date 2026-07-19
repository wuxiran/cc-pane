// 注入内容纯逻辑：8KB（UTF-8 字节）截断 + 与已有字段的拼接。
// 组件（LauncherInjectionRow）只做取内容与 toast，截断规则在此锁定并单测。

/** 注入内容上限（UTF-8 字节）；超出截断并由调用方 toast 告警 */
export const INJECTION_MAX_BYTES = 8 * 1024;

/** 按 UTF-8 字节截断，保证不产生半个多字节字符 */
export function clampInjection(content: string): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(content);
  if (bytes.length <= INJECTION_MAX_BYTES) return { text: content, truncated: false };
  const text = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.slice(0, INJECTION_MAX_BYTES))
    // 截断落在多字节字符中间时 decoder 会补 U+FFFD，剥掉尾部残片
    .replace(/�+$/, "");
  return { text, truncated: true };
}

/** 注入内容拼到已有字段末尾（空行分隔）；任一为空时返回另一个 */
export function appendInjection(existing: string, addition: string): string {
  const base = existing.trim();
  const added = addition.trim();
  if (!base) return added;
  if (!added) return base;
  return `${base}\n\n${added}`;
}
