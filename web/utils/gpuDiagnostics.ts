/**
 * GPU / WebView2 / xterm 环境采集——WebGL 花屏诊断台用。
 *
 * 花屏是「WebView2 + xterm-WebGL 字形图集」的底层问题（见 terminalRenderer.ts 的
 * windows-cjk-guard）。要判断它是否与特定 GPU/驱动/WebView2 版本相关，需要把这些
 * 环境指纹连同复现结果一起采下来做相关性分析。本模块只做**只读采集**，不改任何渲染行为。
 */

// 与 package.json 保持一致（诊断报告里标注被测版本；升级依赖时同步更新）。
export const XTERM_VERSION = "6.0.0";
export const WEBGL_ADDON_VERSION = "0.19.0";

export interface GpuDiagnostics {
  webgl2Supported: boolean;
  webglVersion: string | null;
  /** WEBGL_debug_renderer_info → UNMASKED_VENDOR_WEBGL（如 "Google Inc. (NVIDIA)"） */
  unmaskedVendor: string | null;
  /** UNMASKED_RENDERER_WEBGL（如 "ANGLE (NVIDIA, NVIDIA GeForce ... Direct3D11 ...)"） */
  unmaskedRenderer: string | null;
  maxTextureSize: number | null;
  maxTextureImageUnits: number | null;
  /** ANGLE 后端（d3d11 / d3d9 / gl / vulkan / metal），从 renderer 串里粗解析 */
  angleBackend: string | null;
  devicePixelRatio: number;
  userAgent: string;
  /** 从 UA 解析的 Chromium 主版本 */
  chromiumVersion: string | null;
  /** 从 UA 解析的 Edg/WebView2 版本 */
  webview2Version: string | null;
  platform: string;
  xtermVersion: string;
  webglAddonVersion: string;
  capturedAt: number;
}

function parseUaVersion(ua: string, token: string): string | null {
  const m = new RegExp(`${token}/([0-9.]+)`).exec(ua);
  return m ? m[1] : null;
}

function parseAngleBackend(renderer: string | null): string | null {
  if (!renderer) return null;
  const low = renderer.toLowerCase();
  if (low.includes("direct3d11") || low.includes("d3d11")) return "d3d11";
  if (low.includes("direct3d9") || low.includes("d3d9")) return "d3d9";
  if (low.includes("vulkan")) return "vulkan";
  if (low.includes("metal")) return "metal";
  if (low.includes("opengl")) return "opengl";
  return null;
}

export function captureGpuDiagnostics(nowMs = 0): GpuDiagnostics {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const platform =
    typeof document !== "undefined"
      ? (document.documentElement.dataset.platform ?? "unknown")
      : "unknown";

  let webgl2Supported = false;
  let webglVersion: string | null = null;
  let unmaskedVendor: string | null = null;
  let unmaskedRenderer: string | null = null;
  let maxTextureSize: number | null = null;
  let maxTextureImageUnits: number | null = null;

  try {
    const canvas = document.createElement("canvas");
    const gl =
      (canvas.getContext("webgl2", { antialias: false, depth: false }) as WebGL2RenderingContext | null) ??
      (canvas.getContext("webgl") as WebGLRenderingContext | null);
    if (gl) {
      webgl2Supported = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
      webglVersion = gl.getParameter(gl.VERSION) as string;
      maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      maxTextureImageUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number;
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      if (dbg) {
        unmaskedVendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) as string;
        unmaskedRenderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string;
      }
      const lose = gl.getExtension("WEBGL_lose_context");
      lose?.loseContext();
    }
  } catch {
    /* 采集失败按不可用处理 */
  }

  return {
    webgl2Supported,
    webglVersion,
    unmaskedVendor,
    unmaskedRenderer,
    maxTextureSize,
    maxTextureImageUnits,
    angleBackend: parseAngleBackend(unmaskedRenderer),
    devicePixelRatio: typeof window === "undefined" ? 1 : window.devicePixelRatio,
    userAgent: ua,
    chromiumVersion: parseUaVersion(ua, "Chrome"),
    webview2Version: parseUaVersion(ua, "Edg"),
    platform,
    xtermVersion: XTERM_VERSION,
    webglAddonVersion: WEBGL_ADDON_VERSION,
    capturedAt: nowMs,
  };
}
