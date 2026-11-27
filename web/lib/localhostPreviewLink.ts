import type { IBufferLine, ILink, ILinkProvider, Terminal as XtermTerminal } from "@xterm/xterm";

/**
 * 远程（SSH）终端输出里的回环地址链接：`localhost:3000`、`http://127.0.0.1:5173/app`、
 * `0.0.0.0:8080`、`[::1]:4000`。点开时经 SSH 本地端口转发在本机预览（docs/116 §B）。
 */
export interface LocalhostPreviewLink {
  text: string;
  startIndex: number;
  endIndex: number;
  scheme: "http" | "https";
  /** 远端视角下要连的主机：0.0.0.0 归一为 127.0.0.1，[::1] 去括号 */
  remoteHost: string;
  port: number;
  /** 以 `/` 开头的路径 + 查询，没有时为空串 */
  path: string;
}

const MAX_SCAN_CHARS = 2048;
const MAX_LINKS = 16;
// 前面不能紧贴主机名字符或 `@`/`.`（排除 foo.localhost、user@localhost 这类不是本机回环的写法）
const LOCALHOST_URL =
  /(?<![\w.@/-])(?:(https?):\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{1,5})(?![\d\w])((?:\/[^\s"'<>`]*)?)/giu;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/u;

function normalizeRemoteHost(host: string): string {
  const lower = host.toLowerCase();
  if (lower === "0.0.0.0") return "127.0.0.1";
  if (lower === "[::1]") return "::1";
  return lower;
}

export function findLocalhostPreviewLinks(text: string): LocalhostPreviewLink[] {
  const source = text.slice(0, MAX_SCAN_CHARS);
  const links: LocalhostPreviewLink[] = [];
  for (const match of source.matchAll(LOCALHOST_URL)) {
    const port = Number(match[3]);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) continue;
    const path = (match[4] ?? "").replace(TRAILING_PUNCTUATION, "");
    const prefix = match[0].slice(0, match[0].length - (match[4] ?? "").length);
    const linkText = prefix + path;
    const startIndex = match.index ?? 0;
    links.push({
      text: linkText,
      startIndex,
      endIndex: startIndex + linkText.length,
      scheme: match[1]?.toLowerCase() === "https" ? "https" : "http",
      remoteHost: normalizeRemoteHost(match[2]),
      port,
      path,
    });
    if (links.length >= MAX_LINKS) break;
  }
  return links;
}

/** OSC 8 超链接里的 URL 是否指向回环地址（SSH 会话里点它要走预览而不是本机浏览器）。 */
export function parseLocalhostPreviewUrl(url: string): LocalhostPreviewLink | null {
  const [link] = findLocalhostPreviewLinks(url);
  return link && link.startIndex === 0 && link.endIndex === url.length ? link : null;
}

/** 本机预览地址：隧道只监听 127.0.0.1，所以不用 localhost（避免先解析到 ::1）。 */
export function localPreviewUrl(link: Pick<LocalhostPreviewLink, "scheme" | "path">, localPort: number): string {
  return `${link.scheme}://127.0.0.1:${localPort}${link.path || "/"}`;
}

/** 字符串下标 → 1 基列号（宽字符占两列，组合字符串占多个下标）。 */
function columnIndex(terminal: XtermTerminal, line: IBufferLine): number[] {
  const cell = terminal.buffer.active.getNullCell();
  const columns: number[] = [];
  for (let column = 0; column < line.length; column += 1) {
    line.getCell(column, cell);
    if (!cell.getWidth()) continue;
    const chars = cell.getChars() || " ";
    for (let index = 0; index < chars.length; index += 1) columns.push(column + 1);
  }
  return columns;
}

/** 单行扫描即可：dev server 的地址行很短，不需要像路径链接那样拼接软折行。 */
export class LocalhostPreviewLinkProvider implements ILinkProvider {
  constructor(
    private readonly terminal: XtermTerminal,
    private readonly onActivate: (link: LocalhostPreviewLink) => void,
    private readonly isEnabled: () => boolean,
  ) {}

  provideLinks(viewportLine: number, callback: (links: ILink[] | undefined) => void): void {
    const line = this.isEnabled() ? this.terminal.buffer.active.getLine(viewportLine - 1) : undefined;
    if (!line) {
      callback(undefined);
      return;
    }
    const text = line.translateToString(true);
    const found = findLocalhostPreviewLinks(text);
    const columns = found.length > 0 ? columnIndex(this.terminal, line) : [];
    const links = found.flatMap((link): ILink[] => {
      const start = columns[link.startIndex];
      const end = columns[link.endIndex - 1];
      if (start === undefined || end === undefined) return [];
      return [{
        text: link.text,
        range: { start: { x: start, y: viewportLine }, end: { x: end, y: viewportLine } },
        decorations: { pointerCursor: true, underline: true },
        activate: () => this.onActivate(link),
      }];
    });
    callback(links.length > 0 ? links : undefined);
  }
}
