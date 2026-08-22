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

/** 每个 mock terminal 的 onRender 回调，供用例手动触发一帧。 */
const renderHandlers = new WeakMap<HTMLElement, () => void>();

function createMockTerminal(): Terminal {
  const element = document.createElement("div");
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  element.appendChild(screen);
  // 必须挂进文档：游离节点画不出来，控制器会（正确地）把 atlas 重绘推迟到可见之后。
  document.body.appendChild(element);
  return {
    element,
    rows: 24,
    refresh: vi.fn(),
    clearTextureAtlas: vi.fn(),
    loadAddon: vi.fn(),
    onRender: vi.fn((handler: () => void) => {
      renderHandlers.set(element, handler);
      return { dispose: vi.fn() };
    }),
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

  // 花屏的成因：atlas 重排时隐藏的 pane 画不出来，旧实现直接丢弃这次刷新且无补偿，
  // 切回去时它仍用着失效的字形坐标 → 采样到别的字形碎片（连 ASCII 都会坏）。
  it("defers the atlas repaint while hidden and replays it once visible again", () => {
    const term = createMockTerminal();
    const controller = createTerminalRendererController({
      term,
      logger: vi.fn(),
      onRendererChanged: vi.fn(),
    });
    controller.configure("webgl");

    // 隐藏态：祖先 display:none 的 tab / 非活动布局就是这个形态。
    let visible = false;
    Object.defineProperty(term.element as HTMLElement, "checkVisibility", {
      configurable: true,
      value: () => visible,
    });

    webglMock.instances[0].atlasChangeHandler?.(document.createElement("canvas"));

    expect(term.refresh).not.toHaveBeenCalled();
    expect(controller.getDiagnostics().atlasRefreshDeferredCount).toBe(1);

    visible = true;
    document.dispatchEvent(new Event("visibilitychange"));

    expect(term.refresh).toHaveBeenCalledWith(0, 23);
    controller.dispose();
  });

  // `display:none` 的元素交叉比恒为 0；它恢复显示时若仍在视口外，IntersectionObserver
  // 不会回调（没有跨越阈值）。xterm 画出一帧就是它确实可见的证据，作为第三个补刷时机。
  it("replays a deferred repaint on the next rendered frame", () => {
    const term = createMockTerminal();
    const controller = createTerminalRendererController({
      term,
      logger: vi.fn(),
      onRendererChanged: vi.fn(),
    });
    controller.configure("webgl");
    let visible = false;
    Object.defineProperty(term.element as HTMLElement, "checkVisibility", {
      configurable: true,
      value: () => visible,
    });

    webglMock.instances[0].atlasChangeHandler?.(document.createElement("canvas"));
    expect(term.refresh).not.toHaveBeenCalled();

    visible = true;
    renderHandlers.get(term.element as HTMLElement)?.();

    expect(term.refresh).toHaveBeenCalledWith(0, 23);
  });

  // 重绘失败还把待刷标记清掉，等于把这次补刷永久丢了——GL context 已死但
  // context-loss 事件还没到时会走到这里。
  it("keeps the deferred repaint pending when the repaint itself fails", () => {
    const term = createMockTerminal();
    const controller = createTerminalRendererController({
      term,
      logger: vi.fn(),
      onRendererChanged: vi.fn(),
    });
    controller.configure("webgl");
    vi.mocked(term.refresh).mockImplementationOnce(() => {
      throw new Error("context lost");
    });

    webglMock.instances[0].atlasChangeHandler?.(document.createElement("canvas"));

    expect(term.refresh).toHaveBeenCalledTimes(1);
    expect(controller.getDiagnostics().atlasRefreshDeferredCount).toBe(1);

    // 下一次时机应当重试，而不是当作已经画过。
    renderHandlers.get(term.element as HTMLElement)?.();
    expect(term.refresh).toHaveBeenCalledTimes(2);
  });

  it("stops replaying a deferred repaint after WebGL is torn down", () => {
    const term = createMockTerminal();
    const controller = createTerminalRendererController({
      term,
      logger: vi.fn(),
      onRendererChanged: vi.fn(),
    });
    controller.configure("webgl");
    Object.defineProperty(term.element as HTMLElement, "checkVisibility", {
      configurable: true,
      value: () => false,
    });
    webglMock.instances[0].atlasChangeHandler?.(document.createElement("canvas"));
    expect(term.refresh).not.toHaveBeenCalled();

    // 降级/卸载后模型已作废，重新 enable 会是全新模型——旧的待刷标记不该再触发白刷一帧。
    controller.configure("dom");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(term.refresh).not.toHaveBeenCalledWith(0, 23);
    controller.dispose();
  });
});
