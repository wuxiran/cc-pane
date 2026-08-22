import { describe, expect, it } from "vitest";
import {
  decideTerminalRenderer,
  isMacDesktopWebKitTerminalRendererHost,
  isWebKitTerminalRendererHost,
  isWindowsTerminalRendererHost,
  normalizeTerminalRendererMode,
  resolveTerminalRendererModeForSession,
  shouldUseTerminalWebglRenderer,
} from "./terminalRenderer";

describe("terminal renderer selection", () => {
  it("keeps WebGL enabled for macOS desktop WKWebView in auto mode", () => {
    const safari =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";

    expect(isWebKitTerminalRendererHost(safari)).toBe(true);
    expect(isMacDesktopWebKitTerminalRendererHost(safari)).toBe(true);
    expect(shouldUseTerminalWebglRenderer(safari)).toBe(true);
    expect(decideTerminalRenderer("auto", {
      userAgent: safari,
      webgl2Supported: true,
    })).toMatchObject({
      renderer: "webgl",
      reason: "auto-webgl",
    });
  });

  it("still falls back to DOM for mobile WebKit hosts in auto mode", () => {
    const ios =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1";
    // iPadOS 桌面模式会把自己报成 Macintosh，只有 Mobile 标记能区分。
    const ipadDesktopMode =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1";

    for (const userAgent of [ios, ipadDesktopMode]) {
      expect(isMacDesktopWebKitTerminalRendererHost(userAgent)).toBe(false);
      expect(decideTerminalRenderer("auto", {
        userAgent,
        webgl2Supported: true,
      })).toMatchObject({
        renderer: "dom",
        reason: "webkit-host",
      });
    }
  });

  it("wallpaper transparency still wins over macOS WebGL", () => {
    const safari =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";

    expect(decideTerminalRenderer("auto", {
      userAgent: safari,
      webgl2Supported: true,
      transparencyRequired: true,
    })).toMatchObject({
      renderer: "dom",
      reason: "wallpaper-transparency",
    });
  });

  it("tries WebGL for auto mode on Windows hosts and keeps DOM as runtime fallback", () => {
    const webview2 =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";

    expect(isWebKitTerminalRendererHost(webview2)).toBe(false);
    expect(isWindowsTerminalRendererHost(webview2)).toBe(true);
    expect(shouldUseTerminalWebglRenderer(webview2)).toBe(true);
    expect(decideTerminalRenderer("auto", {
      userAgent: webview2,
      webgl2Supported: true,
    })).toMatchObject({
      renderer: "webgl",
      reason: "auto-webgl",
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

  it("keeps WebGL enabled for Linux hardware renderers in auto mode", () => {
    const linuxChrome =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    expect(isWindowsTerminalRendererHost(linuxChrome)).toBe(false);
    expect(decideTerminalRenderer("auto", {
      userAgent: linuxChrome,
      webgl2Supported: true,
      webglRenderer: "NVIDIA GeForce RTX 4060/PCIe/SSE2",
      webglVendor: "NVIDIA Corporation",
    })).toMatchObject({
      renderer: "webgl",
      reason: "auto-webgl",
    });
  });

  it("falls back to DOM for software WebGL renderers in auto mode", () => {
    const linuxChrome =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    expect(decideTerminalRenderer("auto", {
      userAgent: linuxChrome,
      webgl2Supported: true,
      webglRenderer: "llvmpipe (LLVM 15.0.7, 256 bits)",
      webglVendor: "Mesa",
    })).toMatchObject({
      renderer: "dom",
      reason: "software-renderer",
    });
  });

  it("falls back to DOM for unknown Linux renderer identity in auto mode", () => {
    const linuxChrome =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    expect(decideTerminalRenderer("auto", {
      userAgent: linuxChrome,
      webgl2Supported: true,
    })).toMatchObject({
      renderer: "dom",
      reason: "renderer-identity-unavailable",
    });
  });

  it("falls back to DOM on Linux Wayland in auto mode", () => {
    const linuxChrome =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    expect(decideTerminalRenderer("auto", {
      userAgent: linuxChrome,
      webgl2Supported: true,
      webglRenderer: "NVIDIA GeForce RTX 4060/PCIe/SSE2",
      displayServer: "wayland",
    })).toMatchObject({
      renderer: "dom",
      reason: "linux-wayland",
    });
  });

  it("lets an explicit WebGL choice bypass Linux auto-policy GPU guards", () => {
    const linuxChrome =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    expect(decideTerminalRenderer("webgl", {
      userAgent: linuxChrome,
      webgl2Supported: true,
      webglRenderer: "llvmpipe (LLVM 15.0.7, 256 bits)",
      webglVendor: "Mesa",
      displayServer: "wayland",
    })).toMatchObject({
      renderer: "webgl",
      reason: "user-webgl",
      webglRenderer: "llvmpipe (LLVM 15.0.7, 256 bits)",
      webglVendor: "Mesa",
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

  it("wallpaper transparency forces DOM on non-Windows auto hosts", () => {
    const linuxChrome =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    expect(decideTerminalRenderer("auto", {
      userAgent: linuxChrome,
      webgl2Supported: true,
      transparencyRequired: true,
    })).toMatchObject({
      renderer: "dom",
      reason: "wallpaper-transparency",
      webglAllowed: false,
    });
  });

  it("wallpaper transparency overrides explicit webgl mode", () => {
    const linuxChrome =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    expect(decideTerminalRenderer("webgl", {
      userAgent: linuxChrome,
      webgl2Supported: true,
      transparencyRequired: true,
    })).toMatchObject({
      renderer: "dom",
      reason: "wallpaper-transparency",
    });
  });

  it("Windows 下透明需求仍优先回退 DOM", () => {
    const webview2 =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";

    expect(decideTerminalRenderer("auto", {
      userAgent: webview2,
      webgl2Supported: true,
      transparencyRequired: true,
    })).toMatchObject({
      renderer: "dom",
      reason: "wallpaper-transparency",
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
