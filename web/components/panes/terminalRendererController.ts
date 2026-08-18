import { WebglAddon } from "@xterm/addon-webgl";
import type { IDisposable, Terminal } from "@xterm/xterm";
import type { TerminalRendererMode } from "@/types/settings";
import {
  decideTerminalRenderer,
  normalizeTerminalRendererMode,
  resetTerminalWebglProbe,
  type ActiveTerminalRenderer,
  type TerminalRendererDecision,
} from "./terminalRenderer";

type RendererLogger = (event: string, payload?: Record<string, unknown>) => void;

type ReleasableWebglContext = {
  getExtension(name: "WEBGL_lose_context"): { loseContext(): void } | null;
};

type XtermWebglAddonInternals = {
  _renderer?: {
    _gl?: ReleasableWebglContext;
    _canvas?: HTMLCanvasElement;
  };
};

// 跨终端共享 atlas 协调。
// xterm 让**同配置**的终端共用同一张字形图集（CharAtlasCache）。当某个 pane 因输出新字形
// 导致 atlas 扩容 / 加页 / 合并页时，共享纹理里字形的位置会变，但**每个 pane 各自保存 WebGL
// 顶点模型**；没有同步重建模型的 pane 会采样到错误位置 → 表现为「大片黑 + 稀疏彩色碎片」，
// 点击/滚动触发全量刷新才恢复。所以任一 pane 的 atlas 结构变化时，必须让**所有活跃 WebGL
// 终端**各补一次 refresh。用模块级注册表 + rAF 合并，避免每个事件都全量重画所有 pane。
const atlasRefreshRegistry = new Set<() => void>();
let atlasRefreshScheduled = false;
function notifyAtlasStructureChanged(): void {
  if (atlasRefreshScheduled) return;
  atlasRefreshScheduled = true;
  requestAnimationFrame(() => {
    atlasRefreshScheduled = false;
    for (const refresh of atlasRefreshRegistry) {
      try {
        refresh();
      } catch {
        // 单个 pane 刷新失败不影响其它 pane。
      }
    }
  });
}

export interface TerminalRendererDiagnostics {
  activeRenderer: ActiveTerminalRenderer;
  requestedMode: TerminalRendererMode;
  decisionReason: string;
  contextLossCount: number;
  atlasClearCount: number;
  atlasChangeCount: number;
  atlasCanvasCount: number;
  webglRecreateCount: number;
  lastError: string | null;
  lastDevicePixelRatio: number;
  webglRenderer: string | null;
  webglVendor: string | null;
  webglDisabledAfterContextLoss: boolean;
}

export interface TerminalRendererController {
  configure: (mode: TerminalRendererMode) => void;
  dispose: () => void;
  repaint: (reason: string) => void;
  clearTextureAtlas: (reason: string) => boolean;
  recreateWebgl: (reason: string) => boolean;
  /**
   * 后台降档：释放 WebGL context（含 16 上限的槽位），保持 DOM 渲染。
   * 挂起期间 `configure` 只记账不重建 WebGL（防设置变更/壁纸翻转打穿挂起）。
   */
  suspendWebgl: (reason: string) => void;
  resumeWebgl: (reason: string) => void;
  getDiagnostics: () => TerminalRendererDiagnostics;
  getActiveRenderer: () => ActiveTerminalRenderer;
}

interface CreateTerminalRendererControllerOptions {
  term: Terminal;
  logger: RendererLogger;
  onRendererChanged: (reason: string, diagnostics: TerminalRendererDiagnostics) => void;
}

function getDevicePixelRatio(): number {
  return typeof window === "undefined" ? 1 : window.devicePixelRatio;
}

export function createTerminalRendererController({
  term,
  logger,
  onRendererChanged,
}: CreateTerminalRendererControllerOptions): TerminalRendererController {
  let requestedMode: TerminalRendererMode = "auto";
  let decision: TerminalRendererDecision = decideTerminalRenderer("auto");
  let activeRenderer: ActiveTerminalRenderer = "dom";
  let webglAddon: WebglAddon | null = null;
  let webglDisposables: IDisposable[] = [];
  let disposed = false;
  let configured = false;
  let suspended = false;
  let contextLossCount = 0;
  let atlasClearCount = 0;
  let atlasChangeCount = 0;
  let atlasCanvasCount = 0;
  let webglRecreateCount = 0;
  let webglDisabledAfterContextLoss = false;
  let lastError: string | null = null;
  let lastDevicePixelRatio = getDevicePixelRatio();

  const getDiagnostics = (): TerminalRendererDiagnostics => ({
    activeRenderer,
    requestedMode,
    decisionReason: decision.reason,
    contextLossCount,
    atlasClearCount,
    atlasChangeCount,
    atlasCanvasCount,
    webglRecreateCount,
    lastError,
    lastDevicePixelRatio,
    webglRenderer: decision.webglRenderer,
    webglVendor: decision.webglVendor,
    webglDisabledAfterContextLoss,
  });

  const disposeWebgl = (reason: string) => {
    atlasRefreshRegistry.delete(refreshForSharedAtlas);
    for (const disposable of webglDisposables) {
      try {
        disposable.dispose();
      } catch {
        // Listener cleanup should not block renderer recovery.
      }
    }
    webglDisposables = [];

    // 释放前先抓住底层 WebGL context：@xterm/addon-webgl 0.19 的 dispose() **不会** 调
    // WEBGL_lose_context.loseContext()，被弃的 context 要等 GC 才退出 Chromium 活动集合。
    // 每次 recreate/切换/卸载都漏一个 → 多终端很快撞 ~16 个 live context 上限（花屏/黑屏根因）。
    // 直接读 addon 已有 renderer，避免 canvas.getContext() 在未绑定 canvas 上反向创建新 context。
    const renderer = (webglAddon as unknown as XtermWebglAddonInternals | null)?._renderer;
    const releasableContext = renderer?._gl;
    const rendererCanvas = renderer?._canvas;

    try {
      releasableContext?.getExtension("WEBGL_lose_context")?.loseContext();
      if (rendererCanvas) {
        rendererCanvas.width = 0;
        rendererCanvas.height = 0;
      }
    } catch {
      /* 已丢失 context 的清理可忽略 */
    }

    if (webglAddon) {
      try {
        webglAddon.dispose();
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        logger("renderer.webgl.dispose.fail", {
          reason,
          error: lastError,
        });
      }
      webglAddon = null;
    }

    activeRenderer = "dom";
  };

  const clearTextureAtlas = (reason: string): boolean => {
    if (!webglAddon) return false;

    try {
      term.clearTextureAtlas();
      atlasClearCount += 1;
      lastDevicePixelRatio = getDevicePixelRatio();
      // clearTextureAtlas 本身已清模型并触发 RenderService 全量 refresh，无需额外 repaint。
      // 但它清的是**跨 pane 共享**的 atlas，故通知其它共享 pane 一并刷新，避免它们残留错位。
      notifyAtlasStructureChanged();
      logger("renderer.webgl.atlas.clear", {
        reason,
        atlasClearCount,
        dpr: lastDevicePixelRatio,
      });
      return true;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      logger("renderer.webgl.atlas.clear.fail", {
        reason,
        error: lastError,
      });
      return false;
    }
  };

  const repaint = (reason: string) => {
    requestAnimationFrame(() => {
      if (disposed) return;
      try {
        term.refresh(0, Math.max(0, term.rows - 1));
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        logger("renderer.repaint.refresh.fail", {
          reason,
          error: lastError,
        });
      }
    });
  };

  const refreshAfterRendererRecovery = (reason: string) => {
    try {
      term.refresh(0, Math.max(0, term.rows - 1));
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      logger("renderer.webgl.recovery.refresh.fail", {
        reason,
        error: lastError,
      });
    }
  };

  // 本终端在「共享 atlas 结构变化」时要执行的有界重绘（注册进 atlasRefreshRegistry）。
  // 仅重绘一次、且只在 WebGL 活跃时——普通刷新不新增字形，不会再触发 atlas 变化，故不会级联。
  const refreshForSharedAtlas = () => {
    if (disposed || !webglAddon) return;
    try {
      term.refresh(0, Math.max(0, term.rows - 1));
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  };

  const enableWebgl = () => {
    if (disposed || webglAddon) return;

    const addon = new WebglAddon();
    webglDisposables = [
      addon.onContextLoss(() => {
        contextLossCount += 1;
        webglDisabledAfterContextLoss = true;
        resetTerminalWebglProbe();
        logger("renderer.webgl.context-loss", {
          requestedMode,
          contextLossCount,
        });
        disposeWebgl("context-loss");
        // context 丢失后 canvas 会留成整片黑：降级 DOM 后必须补一次重绘，否则不恢复。
        repaint("context-loss");
        onRendererChanged("webgl.context-loss", getDiagnostics());
      }),
      addon.onChangeTextureAtlas((canvas) => {
        atlasChangeCount += 1;
        logger("renderer.webgl.atlas.change", {
          atlasChangeCount,
          width: canvas.width,
          height: canvas.height,
          dpr: getDevicePixelRatio(),
        });
        // 共享 atlas 结构变化 → 刷新所有共享它的可见 WebGL pane（不只自己），
        // 否则未同步模型的 pane 会采样错位（黑块 + 彩色碎片）。
        notifyAtlasStructureChanged();
      }),
      addon.onAddTextureAtlasCanvas((canvas) => {
        atlasCanvasCount += 1;
        logger("renderer.webgl.atlas.add-canvas", {
          atlasCanvasCount,
          width: canvas.width,
          height: canvas.height,
        });
        // 加页同理，是跨 pane 事件：所有共享该 atlas 的 renderer 都需重建模型。
        notifyAtlasStructureChanged();
      }),
      addon.onRemoveTextureAtlasCanvas((canvas) => {
        atlasCanvasCount = Math.max(0, atlasCanvasCount - 1);
        logger("renderer.webgl.atlas.remove-canvas", {
          atlasCanvasCount,
          width: canvas.width,
          height: canvas.height,
        });
        notifyAtlasStructureChanged();
      }),
    ];

    try {
      term.loadAddon(addon);
    } catch (error) {
      // loadAddon 会同步 activate()；若 shader/renderer 初始化抛错，此时 webglAddon 尚未保存，
      // 上层 catch 看不到这个 addon 也就无法 dispose → context 泄漏。这里显式 dispose 兜底。
      try {
        addon.dispose();
      } catch {
        /* 清理失败忽略 */
      }
      for (const disposable of webglDisposables) {
        try {
          disposable.dispose();
        } catch {
          /* ignore */
        }
      }
      webglDisposables = [];
      throw error;
    }
    webglAddon = addon;
    activeRenderer = "webgl";
    lastError = null;
    lastDevicePixelRatio = getDevicePixelRatio();
    atlasRefreshRegistry.add(refreshForSharedAtlas);
    logger("renderer.webgl.enabled", { ...getDiagnostics() });
  };

  const configure = (mode: TerminalRendererMode) => {
    if (disposed) return;

    const normalizedMode = normalizeTerminalRendererMode(mode);
    const modeChanged = requestedMode !== normalizedMode;
    if (modeChanged) resetTerminalWebglProbe();
    const nextDecision = decideTerminalRenderer(mode);
    if (modeChanged) webglDisabledAfterContextLoss = false;
    const shouldReconfigure =
      !configured ||
      modeChanged ||
      decision.reason !== nextDecision.reason ||
      activeRenderer !== nextDecision.renderer;

    requestedMode = nextDecision.requestedMode;
    decision = nextDecision;
    configured = true;

    // 挂起期间只记账：decision 保存下来，resume 时按最新决策重建。
    if (suspended) return;

    if (!shouldReconfigure && (nextDecision.renderer !== "webgl" || webglAddon)) {
      return;
    }

    disposeWebgl(`configure.${nextDecision.reason}`);

    if (nextDecision.renderer !== "webgl") {
      activeRenderer = "dom";
      logger("renderer.webgl.disabled", { ...getDiagnostics() });
      onRendererChanged(`webgl.disabled.${nextDecision.reason}`, getDiagnostics());
      return;
    }

    if (webglDisabledAfterContextLoss) {
      activeRenderer = "dom";
      logger("renderer.webgl.disabled.context-loss-latched", { ...getDiagnostics() });
      onRendererChanged("webgl.disabled.context-loss-latched", getDiagnostics());
      return;
    }

    try {
      enableWebgl();
      onRendererChanged("webgl.enabled", getDiagnostics());
    } catch (error) {
      disposeWebgl("enable-failed");
      lastError = error instanceof Error ? error.message : String(error);
      activeRenderer = "dom";
      logger("renderer.webgl.enable.fail", {
        ...getDiagnostics(),
        error: lastError,
      });
      onRendererChanged("webgl.enable-failed", getDiagnostics());
    }
  };

  const recreateWebgl = (reason: string): boolean => {
    if (disposed || decision.renderer !== "webgl" || !webglAddon) return false;

    try {
      disposeWebgl(`recreate.${reason}`);
      enableWebgl();
      webglRecreateCount += 1;
      refreshAfterRendererRecovery(reason);
      logger("renderer.webgl.recreated", {
        reason,
        ...getDiagnostics(),
      });
      onRendererChanged(`webgl.recreated.${reason}`, getDiagnostics());
      return true;
    } catch (error) {
      disposeWebgl(`recreate-failed.${reason}`);
      lastError = error instanceof Error ? error.message : String(error);
      activeRenderer = "dom";
      logger("renderer.webgl.recreate.fail", {
        reason,
        ...getDiagnostics(),
        error: lastError,
      });
      onRendererChanged(`webgl.recreate-failed.${reason}`, getDiagnostics());
      return false;
    }
  };

  const suspendWebgl = (reason: string) => {
    if (disposed || suspended) return;
    suspended = true;
    if (webglAddon) {
      disposeWebgl(`suspend.${reason}`);
      repaint(`suspend.${reason}`);
      logger("renderer.webgl.suspended", { reason, ...getDiagnostics() });
      onRendererChanged(`webgl.suspended.${reason}`, getDiagnostics());
    }
  };

  const resumeWebgl = (reason: string) => {
    if (disposed || !suspended) return;
    suspended = false;
    webglDisabledAfterContextLoss = false;
    resetTerminalWebglProbe();
    logger("renderer.webgl.resumed", { reason, ...getDiagnostics() });
    // 按挂起期间可能已更新的最新决策重建（configure 内部处理 webgl/dom 分支与失败降级）。
    configured = false;
    configure(requestedMode);
  };

  return {
    configure,
    dispose: () => {
      disposed = true;
      disposeWebgl("dispose");
    },
    suspendWebgl,
    resumeWebgl,
    repaint,
    clearTextureAtlas,
    recreateWebgl,
    getDiagnostics,
    getActiveRenderer: () => activeRenderer,
  };
}
