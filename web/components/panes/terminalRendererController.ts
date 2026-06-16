import { WebglAddon } from "@xterm/addon-webgl";
import type { IDisposable, Terminal } from "@xterm/xterm";
import type { TerminalRendererMode } from "@/types/settings";
import {
  decideTerminalRenderer,
  type ActiveTerminalRenderer,
  type TerminalRendererDecision,
} from "./terminalRenderer";

type RendererLogger = (event: string, payload?: Record<string, unknown>) => void;

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
}

export interface TerminalRendererController {
  configure: (mode: TerminalRendererMode) => void;
  dispose: () => void;
  repaint: (reason: string) => void;
  clearTextureAtlas: (reason: string) => boolean;
  recreateWebgl: (reason: string) => boolean;
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
  let contextLossCount = 0;
  let atlasClearCount = 0;
  let atlasChangeCount = 0;
  let atlasCanvasCount = 0;
  let webglRecreateCount = 0;
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
  });

  const disposeWebgl = (reason: string) => {
    for (const disposable of webglDisposables) {
      try {
        disposable.dispose();
      } catch {
        // Listener cleanup should not block renderer recovery.
      }
    }
    webglDisposables = [];

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

  const enableWebgl = () => {
    if (disposed || webglAddon) return;

    const addon = new WebglAddon();
    webglDisposables = [
      addon.onContextLoss(() => {
        contextLossCount += 1;
        logger("renderer.webgl.context-loss", {
          requestedMode,
          contextLossCount,
        });
        disposeWebgl("context-loss");
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
      }),
      addon.onAddTextureAtlasCanvas((canvas) => {
        atlasCanvasCount += 1;
        logger("renderer.webgl.atlas.add-canvas", {
          atlasCanvasCount,
          width: canvas.width,
          height: canvas.height,
        });
      }),
      addon.onRemoveTextureAtlasCanvas((canvas) => {
        atlasCanvasCount = Math.max(0, atlasCanvasCount - 1);
        logger("renderer.webgl.atlas.remove-canvas", {
          atlasCanvasCount,
          width: canvas.width,
          height: canvas.height,
        });
      }),
    ];

    term.loadAddon(addon);
    webglAddon = addon;
    activeRenderer = "webgl";
    lastError = null;
    lastDevicePixelRatio = getDevicePixelRatio();
    logger("renderer.webgl.enabled", { ...getDiagnostics() });
  };

  const configure = (mode: TerminalRendererMode) => {
    if (disposed) return;

    const nextDecision = decideTerminalRenderer(mode);
    const shouldReconfigure =
      !configured ||
      requestedMode !== nextDecision.requestedMode ||
      decision.reason !== nextDecision.reason ||
      activeRenderer !== nextDecision.renderer;

    requestedMode = nextDecision.requestedMode;
    decision = nextDecision;
    configured = true;

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

  return {
    configure,
    dispose: () => {
      disposed = true;
      disposeWebgl("dispose");
    },
    repaint,
    clearTextureAtlas,
    recreateWebgl,
    getDiagnostics,
    getActiveRenderer: () => activeRenderer,
  };
}
