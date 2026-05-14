import { describe, expect, it, vi } from "vitest";
import { attachTerminalImeGuard, isLinuxWebKitImeEnvironment } from "./terminalImeGuard";

function createInputEvent(
  type: "beforeinput" | "input",
  options: InputEventInit,
): InputEvent {
  return new InputEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    ...options,
  });
}

function createKeyboardEvent(options: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    composed: true,
    ...options,
  });
}

function createKeydownEvent(options: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    composed: true,
    ...options,
  });
}

describe("terminal IME guard", () => {
  it("detects Linux WebKit without Chromium as the guarded environment", () => {
    expect(isLinuxWebKitImeEnvironment(
      "Linux x86_64",
      "Mozilla/5.0 AppleWebKit/605.1.15 Version/60.5 Safari/605.1.15",
    )).toBe(true);
    expect(isLinuxWebKitImeEnvironment(
      "Linux x86_64",
      "Mozilla/5.0 AppleWebKit/537.36 Chrome/120 Safari/537.36",
    )).toBe(false);
    expect(isLinuxWebKitImeEnvironment(
      "MacIntel",
      "Mozilla/5.0 AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
    )).toBe(false);
  });

  it("forwards only InputEvent.data when compositionstart is missing", () => {
    const textarea = document.createElement("textarea");
    const terminal = { input: vi.fn() };
    const logger = vi.fn();
    const guard = attachTerminalImeGuard({
      textarea,
      terminal,
      enabled: true,
      logger,
      now: () => 1000,
    });

    textarea.value = "你好 ";
    textarea.setSelectionRange(3, 3);

    const beforeInput = createInputEvent("beforeinput", {
      inputType: "insertFromComposition",
      data: "你好",
      isComposing: true,
    });
    const allowed = textarea.dispatchEvent(beforeInput);

    expect(allowed).toBe(false);
    expect(beforeInput.defaultPrevented).toBe(true);
    expect(terminal.input).toHaveBeenCalledWith("你好", true);
    expect(textarea.value).toBe("");
    expect(logger).toHaveBeenCalledWith(
      "ime-guard.malformed-composition.forwarded",
      expect.objectContaining({
        source: "beforeinput",
      }),
    );

    const input = createInputEvent("input", {
      inputType: "insertFromComposition",
      data: "你好",
      isComposing: true,
    });
    textarea.value = "你好 你好";
    textarea.setSelectionRange(5, 5);
    textarea.dispatchEvent(input);

    const compositionEnd = new CompositionEvent("compositionend", {
      data: "你好",
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    textarea.value = "你好 你好";
    textarea.dispatchEvent(compositionEnd);

    expect(terminal.input).toHaveBeenCalledTimes(1);
    expect(input.defaultPrevented).toBe(true);
    expect(compositionEnd.defaultPrevented).toBe(true);
    expect(textarea.value).toBe("");

    guard.dispose();
  });

  it("does not intercept normal composition events with a compositionstart", () => {
    const textarea = document.createElement("textarea");
    const terminal = { input: vi.fn() };
    const guard = attachTerminalImeGuard({
      textarea,
      terminal,
      enabled: true,
    });

    textarea.dispatchEvent(new CompositionEvent("compositionstart", {
      data: "",
      bubbles: true,
      cancelable: true,
      composed: true,
    }));
    const beforeInput = createInputEvent("beforeinput", {
      inputType: "insertFromComposition",
      data: "你好",
      isComposing: true,
    });
    textarea.dispatchEvent(beforeInput);

    expect(beforeInput.defaultPrevented).toBe(false);
    expect(terminal.input).not.toHaveBeenCalled();

    guard.dispose();
  });

  it("suppresses the selection confirmation space after a malformed composition", () => {
    let currentTime = 1000;
    const textarea = document.createElement("textarea");
    const terminal = { input: vi.fn() };
    const guard = attachTerminalImeGuard({
      textarea,
      terminal,
      enabled: true,
      now: () => currentTime,
    });

    textarea.value = "你好 ";
    textarea.setSelectionRange(3, 3);

    textarea.dispatchEvent(createInputEvent("beforeinput", {
      inputType: "insertFromComposition",
      data: "你好",
      isComposing: true,
    }));

    const spaceKey = createKeyboardEvent({
      key: " ",
      code: "Space",
      keyCode: 32,
    });
    expect(guard.handleKeyEvent(spaceKey)).toBe(false);
    expect(spaceKey.defaultPrevented).toBe(true);

    const spaceInput = createInputEvent("beforeinput", {
      inputType: "insertText",
      data: " ",
    });
    textarea.value = "\u00a0";
    textarea.dispatchEvent(spaceInput);

    expect(spaceInput.defaultPrevented).toBe(true);
    expect(textarea.value).toBe("");
    expect(terminal.input).toHaveBeenCalledTimes(1);

    currentTime = 2000;
    const laterSpaceKey = createKeyboardEvent({
      key: " ",
      code: "Space",
      keyCode: 32,
    });
    expect(guard.handleKeyEvent(laterSpaceKey)).toBe(true);

    guard.dispose();
  });

  it("does not suppress a real space when no selection-space residue was present", () => {
    let currentTime = 1000;
    const textarea = document.createElement("textarea");
    const terminal = { input: vi.fn() };
    const guard = attachTerminalImeGuard({
      textarea,
      terminal,
      enabled: true,
      now: () => currentTime,
    });

    textarea.value = "你好";
    textarea.setSelectionRange(2, 2);

    textarea.dispatchEvent(createInputEvent("beforeinput", {
      inputType: "insertFromComposition",
      data: "你好",
      isComposing: true,
    }));

    const spaceKey = createKeyboardEvent({
      key: " ",
      code: "Space",
      keyCode: 32,
    });
    expect(guard.handleKeyEvent(spaceKey)).toBe(true);
    expect(spaceKey.defaultPrevented).toBe(false);

    const spaceInput = createInputEvent("beforeinput", {
      inputType: "insertText",
      data: " ",
    });
    textarea.dispatchEvent(spaceInput);

    expect(spaceInput.defaultPrevented).toBe(false);
    expect(terminal.input).toHaveBeenCalledTimes(1);

    currentTime = 1100;
    const secondSpaceKey = createKeyboardEvent({
      key: " ",
      code: "Space",
      keyCode: 32,
    });
    expect(guard.handleKeyEvent(secondSpaceKey)).toBe(true);

    guard.dispose();
  });

  it("handles input fallback before xterm target listeners", () => {
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    const terminal = { input: vi.fn() };
    const xtermInputListener = vi.fn();

    textarea.addEventListener("input", xtermInputListener, true);

    const guard = attachTerminalImeGuard({
      textarea,
      terminal,
      enabled: true,
    });

    textarea.value = "你好";
    textarea.setSelectionRange(2, 2);

    const input = createInputEvent("input", {
      inputType: "insertFromComposition",
      data: "你好",
      isComposing: true,
    });
    const allowed = textarea.dispatchEvent(input);

    expect(allowed).toBe(false);
    expect(input.defaultPrevented).toBe(true);
    expect(xtermInputListener).not.toHaveBeenCalled();
    expect(terminal.input).toHaveBeenCalledWith("你好", true);
    expect(terminal.input).toHaveBeenCalledTimes(1);

    guard.dispose();
    textarea.remove();
  });

  it("skips xterm textarea diff handling when composing after residual spaces", () => {
    let currentTime = 1000;
    const textarea = document.createElement("textarea");
    const terminal = { input: vi.fn() };
    const logger = vi.fn();
    const guard = attachTerminalImeGuard({
      textarea,
      terminal,
      enabled: true,
      logger,
      now: () => currentTime,
    });

    textarea.value = "\u00a0";
    textarea.setSelectionRange(1, 1);

    const imeKeydown = createKeydownEvent({
      key: "Unidentified",
      code: "",
      keyCode: 229,
    });

    expect(guard.handleKeyEvent(imeKeydown)).toBe(false);
    expect(imeKeydown.defaultPrevented).toBe(false);
    expect(logger).toHaveBeenCalledWith(
      "ime-guard.composition-keydown.skipped",
      expect.objectContaining({
        event: expect.objectContaining({
          key: "Unidentified",
          keyCode: 229,
        }),
      }),
    );

    const beforeInput = createInputEvent("beforeinput", {
      inputType: "insertText",
      data: "你好",
      isComposing: false,
    });
    textarea.dispatchEvent(beforeInput);

    expect(beforeInput.defaultPrevented).toBe(true);
    expect(terminal.input).toHaveBeenCalledWith("你好", true);
    expect(textarea.value).toBe("");

    const input = createInputEvent("input", {
      inputType: "insertText",
      data: "你好",
      isComposing: false,
    });
    textarea.value = "你好";
    textarea.dispatchEvent(input);

    expect(input.defaultPrevented).toBe(true);
    expect(terminal.input).toHaveBeenCalledTimes(1);
    expect(textarea.value).toBe("");

    currentTime = 2500;
    const laterInput = createInputEvent("beforeinput", {
      inputType: "insertText",
      data: "x",
    });
    textarea.dispatchEvent(laterInput);

    expect(laterInput.defaultPrevented).toBe(false);

    guard.dispose();
  });
});
