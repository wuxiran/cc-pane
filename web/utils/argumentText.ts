export type ParsedArguments = { args: string[]; error?: never } | {
  args?: never;
  error: "unclosedQuote" | "nul";
};

/** Argument grouping only. No shell expansion; unquoted/single-quoted backslashes are literal. */
export function parseArgumentText(text: string): ParsedArguments {
  if (text.includes("\0")) return { error: "nul" };
  const args: string[] = [];
  let value = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (quote === '"' && char === "\\" && ['"', "\\"].includes(text[index + 1])) {
        value += text[++index];
      } else value += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/u.test(char)) {
      if (started) args.push(value);
      value = "";
      started = false;
    } else {
      value += char;
      started = true;
    }
  }
  if (quote) return { error: "unclosedQuote" };
  if (started) args.push(value);
  return { args };
}

/** Round-trips every valid argv string, including empty arguments and literal line breaks. */
export function formatArgumentText(args: readonly string[]): string {
  return args.map((arg) => arg && !/[\s'"]/u.test(arg)
    ? arg
    : `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(" ");
}
