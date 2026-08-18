import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { createTerminalRendererController } from "./terminalRendererController";

const webglMock = vi.hoisted(() => {
  const instances: MockWebglAddon[] = [];

  class MockWebglAddon {
    public readonly dispose = vi.fn();
    public readonly loseContext = vi.fn();
    public readonly canvas = document.createElement("canvas");
    public _renderer: {
      _gl: { getExtension: (name: string) => { loseContext(): void } | null };
      _canvas: HTMLCanvasElement;
    } | undefined = {
      _gl: {
        getExtension: (name: string) => name === "WEBGL_lose_context"
          ? { loseContext: this.loseContext }
          : null,
      },
      _canvas: this.canvas,
    };
    public contextLossHandler: (() => void) | null = null;
    public atlasChangeHandler: ((canvas: HTMLCanvasElement) => void) | null = null;

    constructor() {
      instances.push(this);
    }

    public onContextLoss(handler: () => void) {
      this.contextLossHandler = handler;
      return { dispose: vi.fn() };
    }

    public onChangeTextureAtlas(handler: (canvas: HTMLCanvasElement) => void) {
      this.atlasChangeHandler = handler;
      return { dispose: vi.fn() };
    }

    public onAddTextureAtlasCanvas() {
      return { dispose: vi.fn() };
    }

    public onRemoveTextureAtlasCanvas() {
      return { dispose: vi.fn() };
    }
  }

  return { instances, MockWebglAddon };
});

const rendererProbeMock = vi.hoisted(() => ({ reset: vi.fn() }));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: webglMock.MockWebglAddon,
}));

vi.mock("./terminalRenderer", async (importOriginal) => {
  const original = await importOriginal<typeof import("./terminalRenderer")>();
  return {
    ...original,
    resetTerminalWebglProbe: rendererProbeMock.reset,
  };
});

class MockWebGL2RenderingContext {}

function createMockTerminal(): Terminal {
  const element = document.createElement("div");
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  element.appendChild(screen);
  return {
    element,
    rows: 24,
    refresh: vi.fn(),
    clearTextureAtlas: vi.fn(),
    loadAddon: vi.fn(),
    onRender: vi.fn(() => ({ dispose: vi.fn() })),
  } as unknown as Terminal;
}

describe("terminal renderer controller", () => {
  let originalGetContext: HTMLCanvasElement["getContext"];

  beforeEach(() => {
    webglMock.instances.length = 0;
    rendererProbeMock.reset.mockClear();
    originalGetContext = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(window, "WebGL2RenderingContext", {
      configurable: true,
      value: MockWebGL2RenderingContext,
    });
    HTMLCanvasElement.prototype.getContext = vi.fn((contextId: string) => {
      if (contextId === "webgl2") {
        return new MockWebGL2RenderingContext() as RenderingContext;
      }
      return null;
    }) as HTMLCanvasElement["getContext"];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    vi.unstubAllGlobals();
  });

  it("repaints WebGL terminals without clearing the texture atlas", () => {
    const term = createMockTerminal();
    const controller = createTerminalRendererController({
      term,
      logger: vi.fn(),
      onRendererChanged: vi.fn(),
    });

    controller.configure("webgl");
    controller.repaint("active.refit");

    expect(term.loadAddon).toHaveBeenCalledOnce();
    expect(term.clearTextureAtlas).not.toHaveBeenCalled();
    expect(term.refresh).toHaveBeenCalledWith(0, 23);
    expect(controller.getDiagnostics().atlasClearCount).toBe(0);
  });

  it("clears the texture atlas only for explicit recovery requests", () => {
    const term = createMockTerminal();
    const controller = createTerminalRendererController({
      term,
      logger: vi.fn(),
      onRendererChanged: vi.fn(),
    });

    controller.configure("webgl");

    expect(controller.clearTextureAtlas("window.resize")).toBe(true);

    expect(term.clearTextureAtlas).toHaveBeenCalledOnce();
    expect(controller.getDiagnostics().atlasClearCount).toBe(1);
  });

  it("recreates the WebGL addon without replacing the terminal", () => {
    const term = createMockTerminal();
    const onRendererChanged = vi.fn();
    const controller = createTerminalRendererController({
      term,
      logger: vi.fn(),
      onRendererChanged,
    });

    controller.configure("webgl");

    expect(controller.recreateWebgl("atlas.stale")).toBe(true);

    expect(webglMock.instances).toHaveLength(2);
    expect(webglMock.instances[0].dispose).toHaveBeenCalledOnce();
    expect(term.loadAddon).toHaveBeenCalledTimes(2);
    expect(term.refresh).toHaveBeenCalledWith(0, 23);
    expect(controller.getDiagnostics()).toMatchObject({
      activeRenderer: "webgl",
      webglRecreateCount: 1,
    });
    expect(onRendererChanged).toHaveBeenLastCalledWith(
      "webgl.recreated.atlas.stale",
      expect.objectContaining({ activeRenderer: "webgl" }),
    );
  });

  it("skips WebGL recreation when the active renderer is DOM", () => {
    const term = createMockTerminal();
    const controller = createTerminalRendererController({
      term,
      logger: vi.fn(),
      onRendererChanged: vi.fn(),
    });

    controller.configure("dom");

    expect(controller.recreateWebgl("atlas.stale")).toBe(false);
    expect(term.loadAddon).not.toHaveBeenCalled();
    expect(controller.getDiagnostics().webglRecreateCount).toBe(0);
  });

  it("releases a WebGL context when addon activation fails", () => {
    const term = createMockTerminal();
    vi.mocked(term.loadAddon).mockImplementationOnce(() => {
      const addon = webglMock.instances[0];
      const screen = term.element?.querySelector(".xterm-screen");
      addon._renderer = undefined;
      vi.spyOn(addon.canvas, "getContext").mockImplementation((contextId: string) => {
        if (contextId !== "webgl2") return null;
        return {
          getExtension: (name: string) => name === "WEBGL_lose_context"
            ? { loseContext: addon.loseContext }
            : null,
        } as unknown as RenderingContext;
      });
      screen?.appendChild(addon.canvas);
      throw new Error("shader init failed");
    });
    const controller = createTerminalRendererController({
      term,
      logger: vi.fn(),
      onRendererChanged: vi.fn(),
    });

    controller.configure("webgl");

    expect(webglMock.instances).toHaveLength(1);
    expect(webglMock.instances[0].loseContext).toHaveBeenCalledOnce();
    expect(webglMock.instances[0].canvas.width).toBe(0);
    expect(webglMock.instances[0].canvas.height).toBe(0);
    expect(webglMock.instances[0].canvas.isConnected).toBe(false);
    expect(webglMock.instances[0].dispose).toHaveBeenCalledOnce();
    expect(controller.getDiagnostics()).toMatchObject({
      activeRenderer: "dom",
      lastError: "shader init failed",
    });
  });

  it("falls back to DOM and keeps the context-loss latch across suspend/resume", () => {
    const term = createMockTerminal();
    const onRendererChanged = vi.fn();
    const controller = createTerminalRendererController({
      term,
      logger: vi.fn(),
      onRendererChanged,
    });

    controller.configure("webgl");
    rendererProbeMock.reset.mockClear();
    webglMock.instances[0].contextLossHandler?.();

    expect(controller.getDiagnostics()).toMatchObject({
      activeRenderer: "dom",
      contextLossCount: 1,
      webglDisabledAfterContextLoss: true,
    });
    expect(term.refresh).toHaveBeenCalledWith(0, 23);
    expect(webglMock.instances[0].loseContext).toHaveBeenCalledOnce();
    expect(webglMock.instances[0].canvas.width).toBe(0);
    expect(webglMock.instances[0].canvas.height).toBe(0);
    expect(rendererProbeMock.reset).toHaveBeenCalledOnce();
    expect(onRendererChanged).toHaveBeenLastCalledWith(
      "webgl.context-loss",
      expect.objectContaining({ activeRenderer: "dom" }),
    );

    controller.configure("webgl");
    expect(webglMock.instances).toHaveLength(1);
    expect(controller.getDiagnostics().activeRenderer).toBe("dom");

    controller.suspendWebgl("background");
    controller.resumeWebgl("foreground");
    expect(rendererProbeMock.reset).toHaveBeenCalledTimes(2);
    expect(webglMock.instances).toHaveLength(1);
    expect(controller.getDiagnostics()).toMatchObject({
      activeRenderer: "dom",
      webglDisabledAfterContextLoss: true,
    });

    controller.configure("dom");
    controller.configure("webgl");
    expect(webglMock.instances).toHaveLength(2);
    expect(controller.getDiagnostics()).toMatchObject({
      activeRenderer: "webgl",
      webglDisabledAfterContextLoss: false,
    });
  });

  it("repaints every live WebGL terminal when the shared glyph atlas changes", () => {
    const first = createMockTerminal();
    const second = createMockTerminal();
    const firstController = createTerminalRendererController({
      term: first,
      logger: vi.fn(),
      onRendererChanged: vi.fn(),
    });
    const secondController = createTerminalRendererController({
      term: second,
      logger: vi.fn(),
      onRendererChanged: vi.fn(),
    });

    firstController.configure("webgl");
    secondController.configure("webgl");
    webglMock.instances[0].atlasChangeHandler?.(document.createElement("canvas"));

    expect(first.refresh).toHaveBeenCalledWith(0, 23);
    expect(second.refresh).toHaveBeenCalledWith(0, 23);
    firstController.dispose();
    secondController.dispose();
  });
});
