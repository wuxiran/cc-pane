import { describe, expect, it } from "vitest";
import { DARK_TERMINAL_THEME, LIGHT_TERMINAL_THEME } from "./terminalTheme";
import { buildOscColorReply } from "./terminalOscColor";

describe("buildOscColorReply", () => {
  it("replies to foreground color queries", () => {
    expect(buildOscColorReply(10, "?", LIGHT_TERMINAL_THEME)).toBe(
      "\x1b]10;rgb:0000/0000/0000\x1b\\"
    );
  });

  it("replies to background color queries", () => {
    expect(buildOscColorReply(11, "?", DARK_TERMINAL_THEME)).toBe(
      "\x1b]11;rgb:1717/1919/1e1e\x1b\\"
    );
  });

  it("replies to ANSI palette queries", () => {
    expect(buildOscColorReply(4, "12;?", LIGHT_TERMINAL_THEME)).toBe(
      "\x1b]4;12;rgb:5e5e/3434/ffff\x1b\\"
    );
  });

  it("returns null for malformed or unsupported queries", () => {
    expect(buildOscColorReply(4, "12", LIGHT_TERMINAL_THEME)).toBeNull();
    expect(buildOscColorReply(4, "99;?", LIGHT_TERMINAL_THEME)).toBeNull();
    expect(buildOscColorReply(10, "12;?", LIGHT_TERMINAL_THEME)).toBeNull();
  });
});
