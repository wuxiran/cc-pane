// agent-chat 的路径小工具：@引用与文件跳转共用。

export function isAbsolutePath(path: string): boolean {
  return /^([a-zA-Z]:[\\/]|\/|\\\\)/.test(path);
}

export function joinCwd(cwd: string, relative: string): string {
  const separator = cwd.includes("\\") ? "\\" : "/";
  return `${cwd.replace(/[\\/]+$/, "")}${separator}${relative}`;
}

export function toFileUri(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, "/");
  return normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`;
}

/** 路径宽松等价（Windows 大小写 + 分隔符差异），仅用于 UI 高亮/过滤。 */
export function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return normalize(left) === normalize(right);
}
