import { describe, expect, it } from "vitest";
import {
  decideTerminalRenderer,
  isWebKitTerminalRendererHost,
  isWindowsTerminalRendererHost,
  normalizeTerminalRendererMode,
  resolveTerminalRendererModeForSession,
  shouldUseTerminalWebglRenderer,
} from "./terminalRenderer";

describe("terminal renderer selection", () => {
  it("disables WebGL for Safari/WKWebView user agents", () => {
    const safari =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";

    expect(isWebKitTerminalRendererHost(safari)).toBe(true);
    expect(shouldUseTerminalWebglRenderer(safari)).toBe(false);
    expect(decideTerminalRenderer("auto", {
      userAgent: safari,
      webgl2Supported: true,
    })).toMatchObject({
      renderer: "dom",
      reason: "webkit-host",
    });
  });

  it("falls back to DOM for auto mode on Windows hosts (CJK atlas guard)", () => {
    const webview2 =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";

    expect(isWebKitTerminalRendererHost(webview2)).toBe(false);
    expect(isWindowsTerminalRendererHost(webview2)).toBe(true);
    expect(shouldUseTerminalWebglRenderer(webview2)).toBe(false);
    expect(decideTerminalRenderer("auto", {
      userAgent: webview2,
      webgl2Supported: true,
    })).toMatchObject({
      renderer: "dom",
      reason: "windows-cjk-guard",
    });
  });

  it("keeps explicit WebGL usable on Windows hosts", () => {
    const webview2 =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";

    expect(decideTerminalRenderer("webgl", {
      userAgent: webview2,
      webgl2Supported: true,
    })).toMatchObject({
      renderer: "webgl",
      reason: "user-webgl",
    });
  });

  it("keeps WebGL enabled for non-Windows Chromium hosts in auto mode", () => {
    const linuxChrome =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    expect(isWindowsTerminalRendererHost(linuxChrome)).toBe(false);
    expect(shouldUseTerminalWebglRenderer(linuxChrome)).toBe(true);
    expect(decideTerminalRenderer("auto", {
      userAgent: linuxChrome,
      webgl2Supported: true,
    })).toMatchObject({
      renderer: "webgl",
      reason: "auto-webgl",
    });
  });

  it("treats iOS Chrome as a WebKit host", () => {
    const iosChrome =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1";

    expect(isWebKitTerminalRendererHost(iosChrome)).toBe(true);
    expect(shouldUseTerminalWebglRenderer(iosChrome)).toBe(false);
  });

  it("allows forced WebGL on WebKit only when WebGL2 exists", () => {
    const safari =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";

    expect(decideTerminalRenderer("webgl", {
      userAgent: safari,
      webgl2Supported: true,
    })).toMatchObject({
      renderer: "webgl",
      reason: "user-webgl",
    });
  });

  it("falls back to DOM when WebGL2 is unavailable", () => {
    const webview2 =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";

    expect(decideTerminalRenderer("webgl", {
      userAgent: webview2,
      webgl2Supported: false,
    })).toMatchObject({
      renderer: "dom",
      reason: "webgl2-unavailable",
    });
  });

  it("normalizes unknown renderer modes to auto", () => {
    expect(normalizeTerminalRendererMode("unknown")).toBe("auto");
    expect(normalizeTerminalRendererMode("dom")).toBe("dom");
  });

  it("keeps auto renderer mode for Claude on Windows", () => {
    expect(resolveTerminalRendererModeForSession("auto", {
      cliToolId: "claude",
      isWindows: true,
    })).toBe("auto");
  });

  it("keeps explicit WebGL and Codex auto renderer decisions", () => {
    expect(resolveTerminalRendererModeForSession("webgl", {
      cliToolId: "claude",
      isWindows: true,
    })).toBe("webgl");
    expect(resolveTerminalRendererModeForSession("auto", {
      cliToolId: "codex",
      isWindows: true,
    })).toBe("auto");
  });
});
