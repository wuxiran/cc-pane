export function buildCursorPositionReport(
  params: Array<number | number[]>,
  prefix: string | undefined,
  cursorX: number,
  cursorY: number,
): string | null {
  if (params.length !== 1) return null;

  const first = params[0];
  const code = typeof first === "number" ? first : first[0];
  if (code !== 6) return null;

  const row = Math.max(1, cursorY + 1);
  const col = Math.max(1, cursorX + 1);

  if (prefix === "?") {
    return `\u001b[?${row};${col}R`;
  }
  if (!prefix) {
    return `\u001b[${row};${col}R`;
  }

  return null;
}
