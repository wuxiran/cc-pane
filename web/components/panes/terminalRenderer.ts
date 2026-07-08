import type { TerminalRendererMode } from "@/types/settings";

export type ActiveTerminalRenderer = "webgl" | "dom";

export interface TerminalRendererDecision {
  requestedMode: TerminalRendererMode;
  renderer: ActiveTerminalRenderer;
  reason: string;
  webglAllowed: boolean;
  webgl2Supported: boolean;
}

export interface TerminalRendererEnvironment {
  userAgent?: string;
  webgl2Supported?: boolean;
  document?: Document;
  window?: Window & typeof globalThis;
}

export interface TerminalRendererSessionContext {
  cliToolId?: string | null;
  isWindows?: boolean;
}

export function isWebKitTerminalRendererHost(userAgent: string): boolean {
  const normalized = userAgent.toLowerCase();
  if (!normalized.includes("applewebkit")) return false;

  return !(
    normalized.includes("chrome/") ||
    normalized.includes("chromium/") ||
    normalized.includes("edg/")
  );
}

/// Windows/WebView2 上 WebglAddon 存在 CJK 字形图集花屏问题（auto 模式默认避开，
/// 显式选 webgl 仍放行）。
export function isWindowsTerminalRendererHost(userAgent: string): boolean {
  return userAgent.toLowerCase().includes("windows nt");
}

export function normalizeTerminalRendererMode(
  mode: string | null | undefined,
): TerminalRendererMode {
  return mode === "webgl" || mode === "dom" ? mode : "auto";
}

export function isTerminalWebgl2Supported(
  env: TerminalRendererEnvironment = {},
): boolean {
  if (typeof env.webgl2Supported === "boolean") {
    return env.webgl2Supported;
  }

  const targetWindow = env.window ?? (typeof window === "undefined" ? undefined : window);
  const targetDocument = env.document ?? (typeof document === "undefined" ? undefined : document);
  if (!targetWindow?.WebGL2RenderingContext || !targetDocument) return false;

  try {
    const canvas = targetDocument.createElement("canvas");
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      depth: false,
    });
    return gl instanceof targetWindow.WebGL2RenderingContext;
  } catch {
    return false;
  }
}

export function decideTerminalRenderer(
  requestedMode: string | null | undefined,
  env: TerminalRendererEnvironment = {},
): TerminalRendererDecision {
  const mode = normalizeTerminalRendererMode(requestedMode);
  const userAgent =
    env.userAgent ?? (typeof navigator === "undefined" ? "" : navigator.userAgent);
  const webgl2Supported = isTerminalWebgl2Supported(env);

  if (mode === "dom") {
    return {
      requestedMode: mode,
      renderer: "dom",
      reason: "user-dom",
      webglAllowed: false,
      webgl2Supported,
    };
  }

  if (!webgl2Supported) {
    return {
      requestedMode: mode,
      renderer: "dom",
      reason: "webgl2-unavailable",
      webglAllowed: mode === "webgl",
      webgl2Supported,
    };
  }

  if (mode === "webgl") {
    return {
      requestedMode: mode,
      renderer: "webgl",
      reason: "user-webgl",
      webglAllowed: true,
      webgl2Supported,
    };
  }

  if (isWebKitTerminalRendererHost(userAgent)) {
    return {
      requestedMode: mode,
      renderer: "dom",
      reason: "webkit-host",
      webglAllowed: false,
      webgl2Supported,
    };
  }

  if (isWindowsTerminalRendererHost(userAgent)) {
    return {
      requestedMode: mode,
      renderer: "dom",
      reason: "windows-cjk-guard",
      webglAllowed: false,
      webgl2Supported,
    };
  }

  return {
    requestedMode: mode,
    renderer: "webgl",
    reason: "auto-webgl",
    webglAllowed: true,
    webgl2Supported,
  };
}

export function resolveTerminalRendererModeForSession(
  requestedMode: string | null | undefined,
  _context: TerminalRendererSessionContext = {},
): TerminalRendererMode {
  return normalizeTerminalRendererMode(requestedMode);
}

export function shouldUseTerminalWebglRenderer(
  userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
  requestedMode: string | null | undefined = "auto",
  webgl2Supported = true,
): boolean {
  return decideTerminalRenderer(requestedMode, {
    userAgent,
    webgl2Supported,
  }).renderer === "webgl";
}
