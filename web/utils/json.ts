/**
 * 格式化 JSON 字符串（2 空格缩进）
 * @throws 如果 JSON 格式无效
 */
export function formatJSON(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return JSON.stringify(JSON.parse(trimmed), null, 2);
}

/** 判断路径是否为 .json 文件 */
export function isJsonFile(path: string): boolean {
  return path.toLowerCase().endsWith(".json");
}
