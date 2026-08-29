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
