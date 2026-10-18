import { isAbsolutePath } from "./chatPaths";
export interface ParsedFileRef { path: string; line?: number; }
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const CONTROL = /[\u0000-\u001f\u007f]/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
function validPath(path: string): boolean { return Boolean(path) && path.length <= 4096 && !CONTROL.test(path); }
function lineNumber(raw: string | undefined): number | undefined {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function fileUri(raw: string): ParsedFileRef | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "file:" || url.username || url.password || url.search) return null;
    let path = decodeURIComponent(url.pathname);
    if (url.hostname && url.hostname !== "localhost") path = `//${url.hostname}${path}`;
    else if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    if (!validPath(path) || !isAbsolutePath(path)) return null;
    const line = lineNumber(/^#L(\d+)(?:[-C].*)?$/.exec(url.hash)?.[1]);
    return { path, ...(line ? { line } : {}) };
  } catch { return null; }
}
function localPath(raw: string, decode: boolean): ParsedFileRef | null {
  const location = /:(\d+)(?::\d+)?$/.exec(raw);
  let path = location ? raw.slice(0, location.index) : raw;
  try { if (decode) path = decodeURIComponent(path); } catch { return null; }
  if (!validPath(path) || (SCHEME.test(path) && !WINDOWS_DRIVE.test(path))) return null;
  // 绝对路径已经明确表示本地文件；相对行内代码仍要求扩展名，避免把普通词变成链接。
  if (!isAbsolutePath(path) && !/\.[\p{L}\p{N}]{1,16}$/u.test(path)) return null;
  const line = lineNumber(location?.[1]);
  return { path, ...(line ? { line } : {}) };
}
/** 行内代码是原始路径，百分号不作 URL 解码；file URI 则按 URI 规范解码。 */
export function parseFileRef(raw: string): ParsedFileRef | null {
  const value = raw.trim();
  if (!validPath(value) || value.startsWith("#")) return null;
  return /^file:/i.test(value) ? fileUri(value) : localPath(value, false);
}
/** Markdown 目的地保留 web/站内锚点，仅已验证的本地引用进入编辑器。 */
export function parseFileLink(raw: string): ParsedFileRef | null {
  const value = raw.trim();
  if (!validPath(value) || value.startsWith("#") || value.startsWith("//")) return null;
  if (/^file:/i.test(value)) return fileUri(value);
  if (SCHEME.test(value) && !WINDOWS_DRIVE.test(value)) return null;
  const fragment = value.indexOf("#");
  const hash = fragment >= 0 ? value.slice(fragment) : "";
  const lineMatch = /^#L(\d+)(?:[-C].*)?$/.exec(hash);
  if (hash && !lineMatch) return null;
  const path = fragment >= 0 ? value.slice(0, fragment) : value;
  if (path.includes("?")) return null;
  const ref = localPath(path, true);
  const line = lineNumber(lineMatch?.[1]);
  return ref && line ? { ...ref, line } : ref;
}
