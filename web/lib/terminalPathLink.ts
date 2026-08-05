import type { IBufferLine, ILink, ILinkProvider, Terminal as XtermTerminal } from "@xterm/xterm";

export interface TerminalPathReference {
  text: string;
  path: string;
  line?: number;
  column?: number;
}

export interface TerminalPathLinkOptions {
  allowPosixAbsolute: boolean;
}

export interface TerminalPathLink extends TerminalPathReference {
  startIndex: number;
  endIndex: number;
}

export type Osc8TerminalLink =
  | { type: "local"; reference: TerminalPathReference }
  | { type: "external"; url: string };

interface BufferChunk {
  text: string;
  bufferLine: number;
}

interface BufferWindow {
  chunks: BufferChunk[];
  truncatedStart: boolean;
  truncatedEnd: boolean;
}

const MAX_SCAN_CHARS = 2048;
const MAX_CANDIDATES = 16;
const MAX_LOCATION = 10_000_000;
const LOCATION_SUFFIX = /:([1-9]\d*)(?::([1-9]\d*))?$/;
const URI_SCHEME = /^[a-z][a-z\d+.-]*:/i;
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u2069\ufeff]/u;
const FULLWIDTH_BOUNDARY = "　、。，：；！？（）【】《》「」『』";

const WITH_LOCATION = new RegExp(
  `(?:[A-Za-z]:[\\/]|/(?!/)|\\.{1,2}[\\/]|[A-Za-z0-9_.-]+[\\/])` +
    `[^\\r\\n<>\"\x60${FULLWIDTH_BOUNDARY}]*?` +
    `:[1-9]\\d*(?::[1-9]\\d*)?` +
    `(?=$|[\\s,.;!?)}\\]]|[${FULLWIDTH_BOUNDARY}])`,
  "gu",
);
const WITHOUT_LOCATION = new RegExp(
  `(?:[A-Za-z]:[\\/]|/(?!/)|\\.{1,2}[\\/]|[A-Za-z0-9_.-]+[\\/])` +
    `[^\\s<>\"\x60${FULLWIDTH_BOUNDARY}]*` +
    `[^\\s<>\"\x60'),;!?\\]}${FULLWIDTH_BOUNDARY}]`,
  "gu",
);

function hasUnsupportedWindowsSyntax(path: string): boolean {
  if (/^(?:\\\\|\/\/|\\\\[?.]\\)/.test(path)) return true;
  if (/^[A-Za-z]:(?![\\/])/.test(path)) return true;
  const withoutDrive = /^[A-Za-z]:/.test(path) ? path.slice(2) : path;
  return withoutDrive.includes(":");
}

function hasSupportedPathShape(path: string, options: TerminalPathLinkOptions): boolean {
  const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(path);
  if (
    !path ||
    CONTROL_OR_BIDI.test(path) ||
    (!windowsAbsolute && URI_SCHEME.test(path)) ||
    hasUnsupportedWindowsSyntax(path)
  ) {
    return false;
  }
  if (windowsAbsolute) return true;
  if (path.startsWith("/")) return options.allowPosixAbsolute && !path.startsWith("//");
  if (/^\.{1,2}[\\/]/.test(path)) return true;
  return /^[A-Za-z0-9_.-]+[\\/][^\\/]+/u.test(path);
}

export function parseTerminalPathReference(
  text: string,
  options: TerminalPathLinkOptions,
): TerminalPathReference | null {
  if (text.length > MAX_SCAN_CHARS || CONTROL_OR_BIDI.test(text)) return null;
  const suffix = text.match(LOCATION_SUFFIX);
  const path = suffix ? text.slice(0, -suffix[0].length) : text;
  if (!hasSupportedPathShape(path, options)) return null;

  const line = suffix ? Number(suffix[1]) : undefined;
  const column = suffix?.[2] ? Number(suffix[2]) : undefined;
  if ((line !== undefined && line > MAX_LOCATION) || (column !== undefined && column > MAX_LOCATION)) {
    return null;
  }

  return { text, path, line, column };
}

function isUriContinuation(source: string, startIndex: number): boolean {
  const tokenPrefix = source.slice(0, startIndex).match(/[^\s"'()[\]{}<>\u3000\u3001\u3002\uff0c\uff1a\uff1b\uff01\uff1f]*$/u)?.[0] ?? "";
  const tokenStart = startIndex - tokenPrefix.length;
  const token = source.slice(tokenStart).match(/^[^\s"'()[\]{}<>\u3000\u3001\u3002\uff0c\uff1a\uff1b\uff01\uff1f]+/u)?.[0] ?? "";
  return /^[a-z][a-z\d+.-]*:\/\//i.test(token)
    || (tokenStart < startIndex && /^[a-z][a-z\d+.-]*:/i.test(token));
}

function collectMatches(
  source: string,
  expression: RegExp,
  options: TerminalPathLinkOptions,
  links: TerminalPathLink[],
): void {
  for (const match of source.matchAll(expression)) {
    const startIndex = match.index ?? 0;
    if (isUriContinuation(source, startIndex)) continue;
    const parsed = parseTerminalPathReference(match[0], options);
    if (!parsed) continue;
    const endIndex = startIndex + parsed.text.length;
    if (links.some((link) => startIndex < link.endIndex && endIndex > link.startIndex)) continue;
    links.push({ ...parsed, startIndex, endIndex });
  }
}

function collectDelimitedMatches(
  source: string,
  options: TerminalPathLinkOptions,
): TerminalPathLink[] {
  const pairs = new Map([["\"", "\""], ["'", "'"], ["(", ")"], ["[", "]"], ["{", "}"]]);
  const links: TerminalPathLink[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const closing = pairs.get(source[index]);
    if (!closing) continue;
    const end = source.indexOf(closing, index + 1);
    if (end < 0) continue;
    const enclosed = source.slice(index + 1, end);
    const text = enclosed.trim();
    const leadingSpaceCount = enclosed.length - enclosed.trimStart().length;
    const parsed = parseTerminalPathReference(text, options);
    if (parsed && /\s/u.test(parsed.path)) {
      const startIndex = index + 1 + leadingSpaceCount;
      links.push({ ...parsed, startIndex, endIndex: startIndex + parsed.text.length });
    }
    index = end;
  }
  return links;
}

function overlaps(left: TerminalPathLink, right: TerminalPathLink): boolean {
  return left.startIndex < right.endIndex && left.endIndex > right.startIndex;
}

export function findTerminalPathLinks(
  text: string,
  options: TerminalPathLinkOptions,
): TerminalPathLink[] {
  const source = text.slice(0, MAX_SCAN_CHARS);
  const compact: TerminalPathLink[] = [];
  const withLocation: TerminalPathLink[] = [];
  collectMatches(source, WITHOUT_LOCATION, options, compact);
  collectMatches(source, WITH_LOCATION, options, withLocation);

  let links = [...compact];
  for (const delimited of collectDelimitedMatches(source, options)) {
    links = links.filter((link) => !overlaps(link, delimited));
    links.push(delimited);
  }
  for (const spaced of withLocation) {
    if (!/\s/u.test(spaced.path) || links.some((link) => link.startIndex === spaced.startIndex && link.endIndex === spaced.endIndex)) {
      continue;
    }
    const contained = compact.filter(
      (link) => link.startIndex >= spaced.startIndex && link.endIndex <= spaced.endIndex,
    );
    if (contained.length !== 1 || contained[0].startIndex !== spaced.startIndex) continue;
    links = links.filter((link) => !overlaps(link, spaced));
    links.push(spaced);
  }

  const truncated = text.length > MAX_SCAN_CHARS;
  return links
    .filter((link) => !truncated || link.endIndex < source.length)
    .sort((left, right) => left.startIndex - right.startIndex)
    .slice(0, MAX_CANDIDATES);
}

export function classifyOsc8TerminalLink(
  uri: string,
  options: TerminalPathLinkOptions,
): Osc8TerminalLink | null {
  if (uri.length > MAX_SCAN_CHARS || CONTROL_OR_BIDI.test(uri)) return null;
  if (/^https?:\/\//i.test(uri)) {
    try {
      const parsed = new URL(uri);
      const decoded = decodeURIComponent(uri);
      if (!parsed.host || CONTROL_OR_BIDI.test(decoded)) return null;
      return { type: "external", url: uri };
    } catch {
      return null;
    }
  }
  if (!/^file:\/\//i.test(uri)) return null;
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "file:" || (parsed.host && parsed.host !== "localhost")) return null;
    const pathname = decodeURIComponent(parsed.pathname);
    const path = /^\/[A-Za-z]:[\\/]/.test(pathname) ? pathname.slice(1) : pathname;
    const reference = parseTerminalPathReference(path, options);
    return reference ? { type: "local", reference } : null;
  } catch {
    return null;
  }
}

function lineEndsAtRightEdge(terminal: XtermTerminal, line: IBufferLine): boolean {
  const cell = terminal.buffer.active.getNullCell();
  for (let column = line.length - 1; column >= 0; column -= 1) {
    line.getCell(column, cell);
    if (!cell.getWidth() || !cell.getChars()) continue;
    return column + cell.getWidth() >= terminal.cols;
  }
  return false;
}

function getSoftWrappedChunks(terminal: XtermTerminal, viewportLine: number): BufferWindow {
  const buffer = terminal.buffer.active;
  const lineCache = new Map<number, IBufferLine>();
  const getLine = (lineIndex: number) => {
    const cached = lineCache.get(lineIndex);
    if (cached) return cached;
    const line = buffer.getLine(lineIndex);
    if (line) lineCache.set(lineIndex, line);
    return line;
  };
  let first = viewportLine - 1;
  let backwardCharacterCount = 0;
  let truncatedStart = false;
  while (first > 0) {
    const current = getLine(first);
    const previous = getLine(first - 1);
    if (!current?.isWrapped || !previous || !lineEndsAtRightEdge(terminal, previous)) break;
    const previousLength = previous.translateToString(true).length;
    if (backwardCharacterCount + previousLength > MAX_SCAN_CHARS / 2) {
      truncatedStart = true;
      break;
    }
    backwardCharacterCount += previousLength;
    first -= 1;
  }

  const chunks: BufferChunk[] = [];
  let characterCount = 0;
  let truncatedEnd = false;
  for (let lineIndex = first; characterCount < MAX_SCAN_CHARS; lineIndex += 1) {
    const line = getLine(lineIndex);
    if (!line) break;
    const lineText = line.translateToString(true);
    const text = lineText.slice(0, MAX_SCAN_CHARS - characterCount);
    chunks.push({ text, bufferLine: lineIndex });
    characterCount += text.length;
    if (text.length < lineText.length) {
      truncatedEnd = true;
      break;
    }
    const next = getLine(lineIndex + 1);
    if (!next?.isWrapped || !lineEndsAtRightEdge(terminal, line)) break;
    if (characterCount >= MAX_SCAN_CHARS) {
      truncatedEnd = true;
      break;
    }
  }
  return { chunks, truncatedStart, truncatedEnd };
}

function positionWithinLine(terminal: XtermTerminal, bufferLine: number, index: number) {
  const line = terminal.buffer.active.getLine(bufferLine);
  if (!line) return null;
  const cell = terminal.buffer.active.getNullCell();
  let remaining = index;

  for (let column = 0; column < line.length; column += 1) {
    line.getCell(column, cell);
    const width = cell.getWidth();
    if (!width) continue;
    const characterLength = cell.getChars().length || 1;
    if (remaining < characterLength) return { x: column, y: bufferLine };
    remaining -= characterLength;
    if (remaining !== 0) continue;
    for (let next = column + 1; next < line.length; next += 1) {
      line.getCell(next, cell);
      if (cell.getWidth()) return { x: next, y: bufferLine };
    }
    return { x: line.length, y: bufferLine };
  }
  return remaining === 0 ? { x: line.length, y: bufferLine } : null;
}

function bufferPosition(
  terminal: XtermTerminal,
  chunks: BufferChunk[],
  index: number,
  affinity: "start" | "end",
) {
  let remaining = index;
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex];
    const last = chunkIndex === chunks.length - 1;
    if (remaining > chunk.text.length || (affinity === "start" && remaining === chunk.text.length && !last)) {
      remaining -= chunk.text.length;
      continue;
    }
    return positionWithinLine(terminal, chunk.bufferLine, remaining);
  }
  return null;
}

export class TerminalPathLinkProvider implements ILinkProvider {
  constructor(
    private readonly terminal: XtermTerminal,
    private readonly onActivate: (reference: TerminalPathReference) => void,
    private readonly options: TerminalPathLinkOptions,
  ) {}

  provideLinks(viewportLine: number, callback: (links: ILink[] | undefined) => void): void {
    const window = getSoftWrappedChunks(this.terminal, viewportLine);
    const { chunks } = window;
    const source = chunks.map((chunk) => chunk.text).join("");
    const candidates = findTerminalPathLinks(source, this.options).filter((reference) => {
      if (window.truncatedStart && reference.startIndex === 0) return false;
      return !window.truncatedEnd || reference.endIndex < source.length;
    });
    const links = candidates.flatMap((reference): ILink[] => {
      const start = bufferPosition(this.terminal, chunks, reference.startIndex, "start");
      const end = bufferPosition(this.terminal, chunks, reference.endIndex, "end");
      if (!start || !end) return [];
      return [{
        text: reference.text,
        range: {
          start: { x: start.x + 1, y: start.y + 1 },
          end: { x: end.x, y: end.y + 1 },
        },
        decorations: { pointerCursor: true, underline: true },
        activate: () => this.onActivate(reference),
      }];
    });
    callback(links.length > 0 ? links : undefined);
  }
}
