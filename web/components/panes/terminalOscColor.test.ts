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

describe("resolveOscColorQuery", () => {
  it("answers logical background queries for transparent CLI surfaces", () => {
    expect(resolveOscColorQuery(11, "?", DARK_TERMINAL_THEME, {
      preserveTransparentBackground: true,
    })).toEqual({
      handled: true,
      response: "\x1b]11;rgb:1717/1919/1e1e\x1b\\",
    });
  });

  it("blocks opaque background changes on transparent CLI surfaces", () => {
    expect(resolveOscColorQuery(11, "#141414", DARK_TERMINAL_THEME, {
      preserveTransparentBackground: true,
    })).toEqual({
      handled: true,
      response: null,
    });
  });

  it("swallows background set payloads on transparent CLI surfaces", () => {
    const options = { preserveTransparentBackground: true };
    expect(resolveOscColorQuery(11, "#ffffff", DARK_TERMINAL_THEME, options)).toEqual({
      handled: true,
      response: null,
    });
    expect(resolveOscColorQuery(11, "rgb:ffff/0000/0000", DARK_TERMINAL_THEME, options)).toEqual({
      handled: true,
      response: null,
    });
  });

  it("lets background set payloads through on opaque terminal surfaces", () => {
    expect(resolveOscColorQuery(11, "#ffffff", DARK_TERMINAL_THEME, {
      preserveTransparentBackground: false,
    })).toEqual({ handled: false, response: null });
  });

  it("lets foreground set payloads through on transparent terminal surfaces", () => {
    expect(resolveOscColorQuery(10, "#ffffff", DARK_TERMINAL_THEME, {
      preserveTransparentBackground: true,
    })).toEqual({ handled: false, response: null });
  });

  it("leaves background changes available to plain terminals", () => {
    expect(resolveOscColorQuery(11, "#ffffff", DARK_TERMINAL_THEME, {
      preserveTransparentBackground: false,
    })).toEqual({ handled: false, response: null });
  });

  it("keeps foreground and palette query behavior unchanged", () => {
    const options = {
      preserveTransparentBackground: true,
    };

    expect(resolveOscColorQuery(10, "?", LIGHT_TERMINAL_THEME, options)).toEqual({
      handled: true,
      response: "\x1b]10;rgb:0000/0000/0000\x1b\\",
    });
    expect(resolveOscColorQuery(4, "12;?", LIGHT_TERMINAL_THEME, options)).toEqual({
      handled: true,
      response: "\x1b]4;12;rgb:5e5e/3434/ffff\x1b\\",
    });
  });
});
