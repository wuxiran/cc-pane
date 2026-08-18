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
  it("suppresses Codex background queries when wallpaper transparency is active", () => {
    expect(resolveOscColorQuery(11, "?", DARK_TERMINAL_THEME, {
      cliTool: "codex",
      wallpaperTransparencyRequired: true,
    })).toEqual({ handled: true, response: null });
  });

  it("replies to Codex background queries without wallpaper transparency", () => {
    expect(resolveOscColorQuery(11, "?", DARK_TERMINAL_THEME, {
      cliTool: "codex",
      wallpaperTransparencyRequired: false,
    })).toEqual({
      handled: true,
      response: "\x1b]11;rgb:1717/1919/1e1e\x1b\\",
    });
  });

  it("replies to other CLIs even when wallpaper transparency is active", () => {
    expect(resolveOscColorQuery(11, "?", DARK_TERMINAL_THEME, {
      cliTool: "claude",
      wallpaperTransparencyRequired: true,
    })).toEqual({
      handled: true,
      response: "\x1b]11;rgb:1717/1919/1e1e\x1b\\",
    });
  });

  // 这条此前断言的是「设置形态一律放行」——把缺陷锁成了规格。放行意味着落到
  // xterm 内置处理器改掉 theme.background，壁纸被整块盖掉且用户无从恢复。
  it("swallows background *set* payloads for any CLI when wallpaper transparency is active", () => {
    for (const cliTool of ["codex", "claude", "gemini"]) {
      expect(resolveOscColorQuery(11, "#ffffff", DARK_TERMINAL_THEME, {
        cliTool,
        wallpaperTransparencyRequired: true,
      })).toEqual({ handled: true, response: null });
      expect(resolveOscColorQuery(11, "rgb:ffff/0000/0000", DARK_TERMINAL_THEME, {
        cliTool,
        wallpaperTransparencyRequired: true,
      })).toEqual({ handled: true, response: null });
    }
  });

  // 不透明模式下 CLI 自定背景是正当行为，拦截范围必须收窄到壁纸激活时。
  it("lets background set payloads through when wallpaper transparency is off", () => {
    expect(resolveOscColorQuery(11, "#ffffff", DARK_TERMINAL_THEME, {
      cliTool: "codex",
      wallpaperTransparencyRequired: false,
    })).toEqual({ handled: false, response: null });
  });

  // 只拦背景：前景不破坏透明，吞掉反而会让 CLI 的配色判定失真。
  it("lets foreground set payloads through even with wallpaper transparency", () => {
    expect(resolveOscColorQuery(10, "#ffffff", DARK_TERMINAL_THEME, {
      cliTool: "codex",
      wallpaperTransparencyRequired: true,
    })).toEqual({ handled: false, response: null });
  });

  it("keeps foreground and palette query behavior unchanged", () => {
    const options = {
      cliTool: "codex",
      wallpaperTransparencyRequired: true,
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
