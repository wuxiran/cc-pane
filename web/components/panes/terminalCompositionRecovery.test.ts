import { describe, expect, it, vi } from "vitest";
import {
  bindTerminalCompositionRecovery,
  defaultAnimationFrameScheduler,
} from "./terminalCompositionRecovery";

function createAnimationFrameScheduler() {
  let nextHandle = 1;
  const callbacks = new Map<number, FrameRequestCallback>();

  return {
    scheduler: {
      request: vi.fn((callback: FrameRequestCallback) => {
        const handle = nextHandle++;
        callbacks.set(handle, callback);
        return handle;
      }),
      cancel: vi.fn((handle: number) => {
        callbacks.delete(handle);
      }),
    },
    flushFrame: () => {
      const pending = [...callbacks.values()];
      callbacks.clear();
      pending.forEach((callback) => callback(0));
    },
  };
}

describe("terminal composition recovery", () => {
  it("wraps the browser animation frame methods in the default scheduler", () => {
    // A bare native method loses window as `this` in WebView2 and throws
    // Illegal invocation. Identity checks catch that regression even though
    // jsdom is permissive about the receiver.
    expect(defaultAnimationFrameScheduler.request).not.toBe(requestAnimationFrame);
    expect(defaultAnimationFrameScheduler.cancel).not.toBe(cancelAnimationFrame);
  });

  it("recovers once after compositionend and two animation frames", () => {
    const textarea = document.createElement("textarea");
    const onCompositionChange = vi.fn();
    const recover = vi.fn();
    const { scheduler, flushFrame } = createAnimationFrameScheduler();
    const dispose = bindTerminalCompositionRecovery(
      textarea,
      onCompositionChange,
      recover,
      scheduler,
    );

    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    textarea.dispatchEvent(new CompositionEvent("compositionend"));

    expect(onCompositionChange.mock.calls).toEqual([[true], [false]]);
    expect(recover).not.toHaveBeenCalled();

    flushFrame();
    expect(recover).not.toHaveBeenCalled();
    flushFrame();
    expect(recover).toHaveBeenCalledOnce();

    dispose();
  });

  it("cancels a queued recovery when a new composition starts", () => {
    const textarea = document.createElement("textarea");
    const recover = vi.fn();
    const { scheduler, flushFrame } = createAnimationFrameScheduler();
    const dispose = bindTerminalCompositionRecovery(
      textarea,
      vi.fn(),
      recover,
      scheduler,
    );

    textarea.dispatchEvent(new CompositionEvent("compositionend"));
    flushFrame();
    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    flushFrame();

    expect(recover).not.toHaveBeenCalled();
    expect(scheduler.cancel).toHaveBeenCalledOnce();

    dispose();
  });

  it("recovers on blur when the IME never sends compositionend", () => {
    const textarea = document.createElement("textarea");
    const onCompositionChange = vi.fn();
    const recover = vi.fn();
    const { scheduler, flushFrame } = createAnimationFrameScheduler();
    const dispose = bindTerminalCompositionRecovery(
      textarea,
      onCompositionChange,
      recover,
      scheduler,
    );

    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    textarea.dispatchEvent(new FocusEvent("blur"));
    flushFrame();
    flushFrame();

    expect(onCompositionChange.mock.calls).toEqual([[true], [false]]);
    expect(recover).toHaveBeenCalledOnce();
    dispose();
  });

  it("removes listeners and queued frames when disposed", () => {
    const textarea = document.createElement("textarea");
    const onCompositionChange = vi.fn();
    const recover = vi.fn();
    const { scheduler, flushFrame } = createAnimationFrameScheduler();
    const dispose = bindTerminalCompositionRecovery(
      textarea,
      onCompositionChange,
      recover,
      scheduler,
    );

    textarea.dispatchEvent(new CompositionEvent("compositionend"));
    dispose();
    flushFrame();
    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    textarea.dispatchEvent(new CompositionEvent("compositionend"));
    flushFrame();
    flushFrame();

    expect(recover).not.toHaveBeenCalled();
    expect(onCompositionChange).toHaveBeenCalledTimes(1);
  });
});
