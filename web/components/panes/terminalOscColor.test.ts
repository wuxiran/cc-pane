import { describe, expect, it } from "vitest";
import { DARK_TERMINAL_THEME, LIGHT_TERMINAL_THEME } from "./terminalTheme";
import { buildOscColorReply, resolveOscColorQuery } from "./terminalOscColor";

describe("buildOscColorReply", () => {
  it("replies to foreground color queries", () => {
    expect(buildOscColorReply(10, "?", LIGHT_TERMINAL_THEME)).toBe(
      "\x1b]10;rgb:0000/0000/0000\x1b\\"
    );
  });

  it("replies to background color queries", () => {
    expect(buildOscColorReply(11, "?", DARK_TERMINAL_THEME)).toBe(
      "\x1b]11;rgb:1818/1818/1818\x1b\\"
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

describe("resolveOscColorQuery", () => {
  const transparent = { preserveTransparentBackground: true };
  const opaque = { preserveTransparentBackground: false };

  it("answers logical background queries for transparent CLI surfaces", () => {
    expect(resolveOscColorQuery(11, "?", DARK_TERMINAL_THEME, transparent)).toEqual({
      handled: true,
      response: "\x1b]11;rgb:1818/1818/1818\x1b\\",
    });
  });

  it.each(["#141414", "#ffffff", "rgb:ffff/0000/0000"])(
    "swallows background set payload %s on transparent CLI surfaces",
    (payload) => {
      expect(resolveOscColorQuery(11, payload, DARK_TERMINAL_THEME, transparent)).toEqual({
        handled: true,
        response: null,
      });
    },
  );

  it.each([
    ["background set payloads on opaque surfaces", 11, opaque],
    ["foreground set payloads on transparent surfaces", 10, transparent],
  ])("lets %s through", (_label, code, options) => {
    expect(resolveOscColorQuery(code, "#ffffff", DARK_TERMINAL_THEME, options)).toEqual({
      handled: false,
      response: null,
    });
  });

  it("keeps foreground and palette query behavior unchanged", () => {
    expect(resolveOscColorQuery(10, "?", LIGHT_TERMINAL_THEME, transparent)).toEqual({
      handled: true,
      response: "\x1b]10;rgb:0000/0000/0000\x1b\\",
    });
    expect(resolveOscColorQuery(4, "12;?", LIGHT_TERMINAL_THEME, transparent)).toEqual({
      handled: true,
      response: "\x1b]4;12;rgb:5e5e/3434/ffff\x1b\\",
    });
  });
});
