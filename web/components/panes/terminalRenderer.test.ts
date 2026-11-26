import { describe, expect, it } from "vitest";
import {
  decideTerminalRenderer,
  isMacDesktopWebKitTerminalRendererHost,
  isWebKitTerminalRendererHost,
  isWindowsTerminalRendererHost,
  normalizeTerminalRendererMode,
  resolveTerminalRendererModeForSession,
  shouldUseTerminalWebglRenderer,
  type TerminalRendererEnvironment,
} from "./terminalRenderer";

const SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";
const IOS_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1";
// iPadOS 桌面模式会把自己报成 Macintosh，只有 Mobile 标记能区分。
const IPAD_DESKTOP_MODE =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1";
const IOS_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1";
const WEBVIEW2 =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";
const LINUX_CHROME =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const NVIDIA = { webglRenderer: "NVIDIA GeForce RTX 4060/PCIe/SSE2", webglVendor: "NVIDIA Corporation" };
const LLVMPIPE = { webglRenderer: "llvmpipe (LLVM 15.0.7, 256 bits)", webglVendor: "Mesa" };

describe("terminal renderer host detection", () => {
  it.each([
    // [ua, webkit, macDesktopWebKit, windows, shouldUseWebgl]
    ["macOS desktop WKWebView", SAFARI, true, true, false, true],
    ["iOS Safari", IOS_SAFARI, true, false, false, false],
    ["iPad desktop mode", IPAD_DESKTOP_MODE, true, false, false, false],
    ["iOS Chrome (still WebKit)", IOS_CHROME, true, false, false, false],
    ["Windows WebView2", WEBVIEW2, false, false, true, true],
    ["Linux Chrome (no GPU identity → DOM)", LINUX_CHROME, false, false, false, false],
  ])("%s", (_label, ua, webkit, macDesktop, windows, webgl) => {
    expect(isWebKitTerminalRendererHost(ua)).toBe(webkit);
    expect(isMacDesktopWebKitTerminalRendererHost(ua)).toBe(macDesktop);
    expect(isWindowsTerminalRendererHost(ua)).toBe(windows);
    expect(shouldUseTerminalWebglRenderer(ua)).toBe(webgl);
  });
});

describe("decideTerminalRenderer", () => {
  it.each<[string, string, TerminalRendererEnvironment, Record<string, unknown>]>([
    // macOS
    ["keeps WebGL for macOS desktop WKWebView in auto mode", "auto",
      { userAgent: SAFARI, webgl2Supported: true }, { renderer: "webgl", reason: "auto-webgl" }],
    ["supports transparent WebGL on macOS", "auto",
      { userAgent: SAFARI, webgl2Supported: true, transparencyRequired: true }, { renderer: "webgl", reason: "auto-webgl" }],
    ["allows forced WebGL on WebKit when WebGL2 exists", "webgl",
      { userAgent: SAFARI, webgl2Supported: true }, { renderer: "webgl", reason: "user-webgl" }],
    // mobile WebKit
    ["falls back to DOM for iOS in auto mode", "auto",
      { userAgent: IOS_SAFARI, webgl2Supported: true }, { renderer: "dom", reason: "webkit-host" }],
    ["falls back to DOM for iPad desktop mode in auto mode", "auto",
      { userAgent: IPAD_DESKTOP_MODE, webgl2Supported: true }, { renderer: "dom", reason: "webkit-host" }],
    // Windows
    ["tries WebGL in auto mode on Windows (DOM stays the runtime fallback)", "auto",
      { userAgent: WEBVIEW2, webgl2Supported: true }, { renderer: "webgl", reason: "auto-webgl" }],
    ["keeps explicit WebGL usable on Windows", "webgl",
      { userAgent: WEBVIEW2, webgl2Supported: true }, { renderer: "webgl", reason: "user-webgl" }],
    ["Windows 透明终端保持 WebGL", "auto",
      { userAgent: WEBVIEW2, webgl2Supported: true, transparencyRequired: true }, { renderer: "webgl", reason: "auto-webgl" }],
    ["keeps WebGL on Windows with a real GPU", "auto",
      {
        userAgent: WEBVIEW2, webgl2Supported: true,
        webglRenderer: "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)",
        webglVendor: "Google Inc. (Intel)",
      },
      { renderer: "webgl", reason: "auto-webgl" }],
    ["falls back to DOM for Microsoft Basic Render Driver on Windows (RDP / VM)", "auto",
      {
        userAgent: WEBVIEW2, webgl2Supported: true,
        webglRenderer: "ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)",
        webglVendor: "Google Inc. (Microsoft)",
      },
      { renderer: "dom", reason: "software-renderer" }],
    ["falls back to DOM for SwiftShader on Windows (blocklisted driver)", "auto",
      {
        userAgent: WEBVIEW2, webgl2Supported: true,
        webglRenderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
        webglVendor: "Google Inc. (Microsoft)",
      },
      { renderer: "dom", reason: "software-renderer" }],
    ["falls back to DOM when WebGL2 is unavailable even if requested", "webgl",
      { userAgent: WEBVIEW2, webgl2Supported: false }, { renderer: "dom", reason: "webgl2-unavailable" }],
    // Linux
    ["keeps WebGL for Linux hardware renderers in auto mode", "auto",
      { userAgent: LINUX_CHROME, webgl2Supported: true, ...NVIDIA }, { renderer: "webgl", reason: "auto-webgl" }],
    ["falls back to DOM for Linux software renderers in auto mode", "auto",
      { userAgent: LINUX_CHROME, webgl2Supported: true, ...LLVMPIPE }, { renderer: "dom", reason: "software-renderer" }],
    ["falls back to DOM for unknown Linux renderer identity in auto mode", "auto",
      { userAgent: LINUX_CHROME, webgl2Supported: true }, { renderer: "dom", reason: "renderer-identity-unavailable" }],
    ["retains Linux GPU identity protection for transparent terminals", "auto",
      { userAgent: LINUX_CHROME, webgl2Supported: true, transparencyRequired: true },
      { renderer: "dom", reason: "renderer-identity-unavailable", webglAllowed: false }],
    ["falls back to DOM on Linux Wayland in auto mode", "auto",
      { userAgent: LINUX_CHROME, webgl2Supported: true, webglRenderer: NVIDIA.webglRenderer, displayServer: "wayland" },
      { renderer: "dom", reason: "linux-wayland" }],
    ["lets explicit WebGL bypass Linux auto-policy GPU guards", "webgl",
      { userAgent: LINUX_CHROME, webgl2Supported: true, ...LLVMPIPE, displayServer: "wayland" },
      { renderer: "webgl", reason: "user-webgl", ...LLVMPIPE }],
    ["supports transparent backgrounds in explicit WebGL mode on Linux", "webgl",
      { userAgent: LINUX_CHROME, webgl2Supported: true, transparencyRequired: true },
      { renderer: "webgl", reason: "user-webgl" }],
  ])("%s", (_label, mode, env, expected) => {
    expect(decideTerminalRenderer(mode, env)).toMatchObject(expected);
  });
});

describe("renderer mode normalization", () => {
  it("normalizes unknown renderer modes to auto", () => {
    expect(normalizeTerminalRendererMode("unknown")).toBe("auto");
    expect(normalizeTerminalRendererMode("dom")).toBe("dom");
  });

  it.each([
    ["auto", "claude", "auto"],
    ["webgl", "claude", "webgl"],
    ["auto", "codex", "auto"],
  ])("keeps %s for %s on Windows", (mode, cliToolId, expected) => {
    expect(resolveTerminalRendererModeForSession(mode, { cliToolId, isWindows: true })).toBe(expected);
  });
});
