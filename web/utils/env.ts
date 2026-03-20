/**
 * 解析 KEY=VALUE 格式的多行文本为键值对对象。
 * 忽略空行和无 `=` 的行。
 */
export function parseEnvLines(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!text.trim()) return result;

  for (const line of text.trim().split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) {
      result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return result;
}

/**
 * 将键值对对象格式化为 KEY=VALUE 多行文本。
 */
export function formatEnvLines(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}
