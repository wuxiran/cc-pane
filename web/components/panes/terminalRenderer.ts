import type { TerminalRendererMode } from "@/types/settings";

export type ActiveTerminalRenderer = "webgl" | "dom";

export interface TerminalRendererDecision {
  requestedMode: TerminalRendererMode;
  renderer: ActiveTerminalRenderer;
  reason: string;
  webglAllowed: boolean;
  webgl2Supported: boolean;
  webglRenderer: string | null;
  webglVendor: string | null;
}

export interface TerminalRendererEnvironment {
  userAgent?: string;
  webgl2Supported?: boolean;
  document?: Document;
  window?: Window & typeof globalThis;
  /** 壁纸终端透明需求（测试注入用；缺省走注册的 provider） */
  transparencyRequired?: boolean;
  /** Optional GPU identity injected by tests or a host diagnostics bridge. */
  webglRenderer?: string | null;
  webglVendor?: string | null;
  displayServer?: "wayland" | "x11" | null;
}

// 壁纸透明需求 provider：由 useWallpaperStore 模块注册，本文件保持纯函数、不 import store。
// WebGL 渲染器不透传背景（不覆盖就是黑底），透明需求必须降 DOM。
let transparencyRequiredProvider: () => boolean = () => false;

export function setTerminalTransparencyProvider(provider: () => boolean): void {
  transparencyRequiredProvider = provider;
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

/// macOS 桌面 WKWebView。移动端 WebKit（iOS/iPadOS，含桌面模式下把自己报成
/// Macintosh 的 iPad）排除在外——WebGL 残影与显存压力在移动端更明显，仍走 DOM。
export function isMacDesktopWebKitTerminalRendererHost(userAgent: string): boolean {
  if (!isWebKitTerminalRendererHost(userAgent)) return false;

  const normalized = userAgent.toLowerCase();
  if (!normalized.includes("macintosh")) return false;

  return !(
    normalized.includes("mobile") ||
    normalized.includes("iphone") ||
    normalized.includes("ipad") ||
    normalized.includes("ipod")
  );
}

/// Windows/WebView2 host 判定。Orca 的策略是在支持 WebGL2 时让 auto 先走 GPU，
/// 运行时 context-loss / addon 初始化失败再由 controller 回退到 DOM。
export function isWindowsTerminalRendererHost(userAgent: string): boolean {
  return userAgent.toLowerCase().includes("windows nt");
}

export function normalizeTerminalRendererMode(
  mode: string | null | undefined,
): TerminalRendererMode {
  return mode === "webgl" || mode === "dom" ? mode : "auto";
}

const SOFTWARE_RENDERER_PATTERN =
  /\b(swiftshader|llvmpipe|softpipe|software rasterizer|software adapter|basic render|virgl|svga3d)\b/i;

interface TerminalWebglProbe {
  supported: boolean;
  renderer: string | null;
  vendor: string | null;
  hasRendererIdentity: boolean;
}

// WebGL2 capability and GPU identity are stable for one renderer process.
// Cache the complete probe so Linux policy does not lose renderer identity on
// the second terminal. Failed probes remain retryable after transient context pressure.
let cachedWebglProbe: TerminalWebglProbe | undefined;

export function resetTerminalWebglProbe(): void {
  cachedWebglProbe = undefined;
}

function isLinuxTerminalRendererHost(userAgent: string): boolean {
  return userAgent.toLowerCase().includes("linux");
}

function probeTerminalWebgl(
  env: TerminalRendererEnvironment,
): TerminalWebglProbe {
  if (typeof env.webgl2Supported === "boolean") {
    const renderer = env.webglRenderer ?? null;
    const vendor = env.webglVendor ?? null;
    return {
      supported: env.webgl2Supported,
      renderer,
      vendor,
      hasRendererIdentity: renderer !== null || vendor !== null,
    };
  }

  const isDefaultEnv = !env.window && !env.document;
  if (isDefaultEnv && cachedWebglProbe) {
    return cachedWebglProbe;
  }

  const targetWindow = env.window ?? (typeof window === "undefined" ? undefined : window);
  const targetDocument = env.document ?? (typeof document === "undefined" ? undefined : document);
  if (!targetWindow?.WebGL2RenderingContext || !targetDocument) {
    return { supported: false, renderer: null, vendor: null, hasRendererIdentity: false };
  }

  try {
    const canvas = targetDocument.createElement("canvas");
    const gl = canvas.getContext("webgl2", { antialias: false, depth: false });
    if (!gl) {
      return { supported: false, renderer: null, vendor: null, hasRendererIdentity: false };
    }

    let renderer: string | null = null;
    let vendor: string | null = null;
    try {
      const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
      if (debugInfo) {
        renderer = String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? "") || null;
        vendor = String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) ?? "") || null;
      }
    } catch {
      // A supported WebGL context without debug identity is still usable on non-Linux hosts.
    }

    try {
      (gl.getExtension("WEBGL_lose_context") as { loseContext(): void } | null)?.loseContext();
    } catch {
      /* probe cleanup is best effort */
    }
    const result = {
      supported: true,
      renderer,
      vendor,
      hasRendererIdentity: renderer !== null || vendor !== null,
    };
    if (isDefaultEnv) cachedWebglProbe = result;
    return result;
  } catch {
    return { supported: false, renderer: null, vendor: null, hasRendererIdentity: false };
  }
}

export function isTerminalWebgl2Supported(
  env: TerminalRendererEnvironment = {},
): boolean {
  return probeTerminalWebgl(env).supported;
}

export function decideTerminalRenderer(
  requestedMode: string | null | undefined,
  env: TerminalRendererEnvironment = {},
): TerminalRendererDecision {
  const mode = normalizeTerminalRendererMode(requestedMode);
  const userAgent =
    env.userAgent ?? (typeof navigator === "undefined" ? "" : navigator.userAgent);
  const displayServer = env.displayServer ?? (
    typeof document === "undefined"
      ? null
      : document.documentElement.dataset.displayServer === "wayland"
        ? "wayland"
        : document.documentElement.dataset.displayServer === "x11"
          ? "x11"
          : null
  );
  const webglProbe = probeTerminalWebgl(env);
  const webgl2Supported = webglProbe.supported;
  const probeDiagnostics = {
    webglRenderer: webglProbe.renderer,
    webglVendor: webglProbe.vendor,
  };
  const transparencyRequired = env.transparencyRequired ?? transparencyRequiredProvider();

  if (mode === "dom") {
    return {
      requestedMode: mode,
      renderer: "dom",
      reason: "user-dom",
      webglAllowed: false,
      webgl2Supported,
      ...probeDiagnostics,
    };
  }

  if (!webgl2Supported) {
    return {
      requestedMode: mode,
      renderer: "dom",
      reason: "webgl2-unavailable",
      webglAllowed: mode === "webgl",
      webgl2Supported,
      ...probeDiagnostics,
    };
  }

  if (mode === "webgl") {
    // 用户显式选 webgl 也必须被透明需求覆盖：WebGL 不透传背景。
    if (transparencyRequired) {
      return {
        requestedMode: mode,
        renderer: "dom",
        reason: "wallpaper-transparency",
        webglAllowed: false,
        webgl2Supported,
        ...probeDiagnostics,
      };
    }
    return {
      requestedMode: mode,
      renderer: "webgl",
      reason: "user-webgl",
      webglAllowed: true,
      webgl2Supported,
      ...probeDiagnostics,
    };
  }

  // macOS 桌面 WKWebView 放行 WebGL：DOM 渲染器在 Retina 上把打包的等宽 webfont
  // 渲染得发虚。早期整体降级是为规避 WebKit 局部重绘后残留旧单元格背景，现在
  // terminalRendererController 已有 context-loss / atlas 重建 / repaint 兜底；
  // 万一复发，设置里显式选 dom 即可退回。移动端 WebKit 仍降级。
  if (isWebKitTerminalRendererHost(userAgent) && !isMacDesktopWebKitTerminalRendererHost(userAgent)) {
    return {
      requestedMode: mode,
      renderer: "dom",
      reason: "webkit-host",
      webglAllowed: false,
      webgl2Supported,
      ...probeDiagnostics,
    };
  }

  if (transparencyRequired) {
    return {
      requestedMode: mode,
      renderer: "dom",
      reason: "wallpaper-transparency",
      webglAllowed: false,
      webgl2Supported,
      ...probeDiagnostics,
    };
  }

  if (isLinuxTerminalRendererHost(userAgent)) {
    if (displayServer === "wayland") {
      return {
        requestedMode: mode,
        renderer: "dom",
        reason: "linux-wayland",
        webglAllowed: false,
        webgl2Supported,
        ...probeDiagnostics,
      };
    }
    if (!webglProbe.hasRendererIdentity) {
      return {
        requestedMode: mode,
        renderer: "dom",
        reason: "renderer-identity-unavailable",
        webglAllowed: false,
        webgl2Supported,
        ...probeDiagnostics,
      };
    }
    const identity = `${webglProbe.vendor ?? ""} ${webglProbe.renderer ?? ""}`;
    if (SOFTWARE_RENDERER_PATTERN.test(identity)) {
      return {
        requestedMode: mode,
        renderer: "dom",
        reason: "software-renderer",
        webglAllowed: false,
        webgl2Supported,
        ...probeDiagnostics,
      };
    }
  }

  return {
    requestedMode: mode,
    renderer: "webgl",
    reason: "auto-webgl",
    webglAllowed: true,
    webgl2Supported,
    ...probeDiagnostics,
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
