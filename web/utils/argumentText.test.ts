import { describe, expect, it } from "vitest";
import { formatArgumentText, parseArgumentText } from "./argumentText";

describe("MCP argument text", () => {
  it("groups quoted values, concatenates fragments and preserves empty arguments", () => {
    expect(parseArgumentText(`--name="two words" '' "" 'single "quote"' "double 'quote'"`)).toEqual({
      args: ["--name=two words", "", "", 'single "quote"', "double 'quote'"],
    });
  });

  it("preserves Windows backslashes unquoted and inside single quotes", () => {
    expect(parseArgumentText(String.raw`C:\tools\mcp.js \\server\share 'C:\Program Files\Tool\'`)).toEqual({
      args: [String.raw`C:\tools\mcp.js`, String.raw`\\server\share`, "C:\\Program Files\\Tool\\"],
    });
  });

  it("supports only quote/backslash escapes within double quotes", () => {
    expect(parseArgumentText(String.raw`"C:\\Program Files\\Tool\\" "say \"hello\"" "literal\n"`)).toEqual({
      args: ["C:\\Program Files\\Tool\\", 'say "hello"', String.raw`literal\n`],
    });
  });

  it("never expands variables, home directories, wildcards or commands", () => {
    expect(parseArgumentText(`$HOME %APPDATA% ~/config *.json '$(touch /tmp/should-not-exist)'`)).toEqual({
      args: ["$HOME", "%APPDATA%", "~/config", "*.json", "$(touch /tmp/should-not-exist)"],
    });
  });

  const samples = [[], [""], ["a", "", "b"], ["two words", 'a"b', "a'b", "C:\\Program Files\\Tool\\", String.raw`\\server\share`], ["line\nbreak", "tab\there", "carriage\rreturn", "中文 空格"]];
  it.each(samples.map((args) => ({ args })))(
    "round-trips argv $args", ({ args }) => {
      expect(parseArgumentText(formatArgumentText(args))).toEqual({ args });
    },
  );

  it.each([`"unfinished`, `'unfinished`, String.raw`"trailing\"`])("rejects an unclosed quote in %s", (text) => {
    expect(parseArgumentText(text)).toEqual({ error: "unclosedQuote" });
  });

  it("rejects NUL rather than passing an invalid OS argument", () => {
    expect(parseArgumentText("valid\0invalid")).toEqual({ error: "nul" });
  });
});
