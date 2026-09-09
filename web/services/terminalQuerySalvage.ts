/**
 * Extract only terminal queries whose replies are handled by the xterm parser.
 * Text and state-changing CSI/OSC sequences stay on the normal output path.
 */
const TERMINAL_QUERY =
  /\x1b\[(?:\?|>)?6n|\x1b\[>c|\x1b\[c|\x1b\[\?[0-9;]*\$p|\x1b\[\?[0-9;]*u|\x1b\](?:4|10|11);\?(?:\x07|\x1b\\)/g;

export function extractTerminalQueries(data: string): string {
  return [...data.matchAll(TERMINAL_QUERY)].map((match) => match[0]).join("");
}

