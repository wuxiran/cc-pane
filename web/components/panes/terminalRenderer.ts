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

// WebGL2 是否支持在一个渲染进程内不会变——按进程缓存探测结果。
// 否则每次 decideTerminalRenderer() 都会 getContext('webgl2') 新建一个探测 context 且从不释放，
// 每个终端构造 + 每次 configure 都漏 1 个，很快撑爆 Chromium 每进程 ~16 个 live WebGL context 上限。
let cachedWebgl2Support: boolean | undefined;

export function isTerminalWebgl2Supported(
  env: TerminalRendererEnvironment = {},
): boolean {
  if (typeof env.webgl2Supported === "boolean") {
    return env.webgl2Supported;
  }

  // 仅默认环境（无注入 window/document，即真实运行时）走进程级缓存；测试注入自定义环境时不缓存。
  const isDefaultEnv = !env.window && !env.document;
  if (isDefaultEnv && cachedWebgl2Support !== undefined) {
    return cachedWebgl2Support;
  }

  const targetWindow = env.window ?? (typeof window === "undefined" ? undefined : window);
  const targetDocument = env.document ?? (typeof document === "undefined" ? undefined : document);
  if (!targetWindow?.WebGL2RenderingContext || !targetDocument) return false;

  let supported = false;
  try {
    const canvas = targetDocument.createElement("canvas");
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      depth: false,
    });
    supported = gl instanceof targetWindow.WebGL2RenderingContext;
    // 立刻释放探测 context，别占用 live context 预算（这是花屏/黑屏的根因之一）。
    // 释放放在独立 try 里：清理失败绝不能翻转 supported 判定。
    try {
      (gl?.getExtension?.("WEBGL_lose_context") as { loseContext(): void } | null)?.loseContext();
    } catch {
      /* 探测 context 清理失败可忽略 */
    }
  } catch {
    supported = false;
  }

  // 只缓存 true：WebGL2 一旦被证实支持就不会变；而 false 可能是 context 瞬时紧张导致
  // getContext 返回 null，缓存它会让本进程之后永久错误降级 DOM，故对 false 下次重试。
  if (isDefaultEnv && supported) {
    cachedWebgl2Support = true;
  }
  return supported;
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
