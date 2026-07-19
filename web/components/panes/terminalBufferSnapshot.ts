/**
 * 终端缓冲区快照工具：把 xterm buffer 序列化成纯文本（复制/导出用），
 * 以及导出文件名生成。只依赖 buffer 的最小结构，方便测试与 mock。
 */

export interface TerminalBufferLineLike {
  translateToString(trimRight?: boolean): string;
}

export interface TerminalBufferLike {
  length: number;
  getLine(y: number): TerminalBufferLineLike | undefined;
}

export interface TerminalWithBufferLike {
  buffer: { active: TerminalBufferLike };
}

/** 序列化当前活动缓冲区为纯文本（含 scrollback），并裁掉末尾空行。 */
export function serializeTerminalBuffer(term: TerminalWithBufferLike): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buffer.length; y++) {
    lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.join("\n");
}

/** 导出文件名：<项目名>-terminal-YYYYMMDD-HHmmss.txt，项目名过滤非法字符。 */
export function buildTerminalExportFileName(projectPath: string, now: Date): string {
  const rawName = projectPath.split(/[/\\]/).filter(Boolean).pop() ?? "terminal";
  const safeName = rawName.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "terminal";
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${safeName}-terminal-${stamp}.txt`;
}
