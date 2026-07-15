import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { createTerminalRendererController } from "./terminalRendererController";

const webglMock = vi.hoisted(() => {
  const instances: MockWebglAddon[] = [];

  class MockWebglAddon {
    public readonly dispose = vi.fn();
    public contextLossHandler: (() => void) | null = null;

    constructor() {
      instances.push(this);
    }

    public onContextLoss(handler: () => void) {
      this.contextLossHandler = handler;
      return { dispose: vi.fn() };
    }

    public onChangeTextureAtlas() {
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

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: webglMock.MockWebglAddon,
}));

class MockWebGL2RenderingContext {}

function createMockTerminal(): Terminal {
  return {
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
});
