import { describe, expect, it, vi } from "vitest";
import {
  attachTerminalImeGuard,
  createTerminalImeGuard,
} from "./terminalImeGuard";

function clock(start = 0) {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

function inputEvent(data: string, inputType = "insertText", isComposing = false) {
  return {
    data,
    inputType,
    isComposing,
  };
}

describe("terminalImeGuard", () => {
  it("passes data through when disabled", () => {
    const guard = createTerminalImeGuard({ enabled: false });

    guard.compositionStart();
    guard.input(inputEvent("你", "insertText", true));
    guard.compositionEnd({ data: "你" });

    expect(guard.filterData("你")).toBe("你");
    expect(guard.filterData("你")).toBe("你");
  });

  it("drops delayed compositionend data after input already forwarded it", () => {
    const logger = vi.fn();
    const time = clock();
    const guard = createTerminalImeGuard({
      enabled: true,
      now: time.now,
      logger,
    });

    guard.compositionStart();
    guard.input(inputEvent("你", "insertText", true));

    expect(guard.filterData("你")).toBe("你");

    guard.compositionEnd({ data: "你" });

    expect(guard.filterData("你")).toBe("");
    expect(logger).toHaveBeenCalledWith("ime.duplicate.drop", {
      source: "compositionend",
      length: 1,
    });
  });

  it("drops duplicate data when xterm onData fires before the input listener records it", () => {
    const guard = createTerminalImeGuard({ enabled: true });

    guard.compositionStart();

    expect(guard.filterData("你")).toBe("你");

    guard.input(inputEvent("你", "insertText", true));
    guard.compositionEnd({ data: "你" });

    expect(guard.filterData("你")).toBe("");
  });

  it("drops input data after compositionend already forwarded it", () => {
    const guard = createTerminalImeGuard({ enabled: true });

    guard.compositionStart();
    guard.compositionEnd({ data: "中" });

    expect(guard.filterData("中")).toBe("中");

    guard.input(inputEvent("中", "insertText", false));

    expect(guard.filterData("中")).toBe("");
  });

  it("trims duplicate prefix while preserving new suffix data", () => {
    const logger = vi.fn();
    const guard = createTerminalImeGuard({ enabled: true, logger });

    guard.compositionStart();
    guard.input(inputEvent("你", "insertText", true));

    expect(guard.filterData("你")).toBe("你");

    guard.compositionEnd({ data: "你" });

    expect(guard.filterData("你2")).toBe("2");
    expect(logger).toHaveBeenCalledWith("ime.duplicate.trim", {
      source: "compositionend",
      originalLength: 2,
      duplicateLength: 1,
      suffixLength: 1,
    });
  });

  it("drops combined duplicate data when suffix was already sent separately", () => {
    const guard = createTerminalImeGuard({ enabled: true });

    guard.compositionStart();
    guard.input(inputEvent("你", "insertText", true));

    expect(guard.filterData("你")).toBe("你");

    guard.compositionEnd({ data: "你" });

    expect(guard.filterData("2")).toBe("2");
    expect(guard.filterData("你2")).toBe("");
  });

  it("trims stale cumulative textarea payloads across composition commits", () => {
    const logger = vi.fn();
    const guard = createTerminalImeGuard({ enabled: true, logger });

    guard.compositionStart();
    expect(guard.filterData("你好")).toBe("你好");
    guard.input(inputEvent("你好", "insertText", true));
    guard.compositionEnd({ data: "你好" });
    expect(guard.filterData("你好")).toBe("");

    guard.compositionStart();
    expect(guard.filterData("你好你好")).toBe("你好");

    expect(logger).toHaveBeenCalledWith("ime.cumulative.trim", {
      originalLength: 4,
      prefixLength: 2,
      suffixLength: 2,
    });
  });

  it("drops repeated cumulative textarea payloads after the suffix was forwarded", () => {
    const logger = vi.fn();
    const guard = createTerminalImeGuard({ enabled: true, logger });

    guard.compositionStart();
    expect(guard.filterData("你好")).toBe("你好");
    guard.compositionEnd({ data: "你好" });
    expect(guard.filterData("你好")).toBe("");

    guard.compositionStart();
    guard.beforeInput(inputEvent("你好", "insertText", true));
    expect(guard.filterData("你好你好")).toBe("你好");
    guard.compositionEnd({ data: "你好" });

    expect(guard.filterData("你好你好")).toBe("");
    expect(logger).toHaveBeenCalledWith("ime.cumulative.drop", {
      source: "compositionend",
      originalLength: 4,
      prefixLength: 2,
      suffixLength: 2,
    });
  });

  it("trims cumulative payloads to the current composition candidate", () => {
    const guard = createTerminalImeGuard({ enabled: true });

    guard.compositionStart();
    expect(guard.filterData("你好")).toBe("你好");
    guard.compositionEnd({ data: "你好" });
    expect(guard.filterData("你好")).toBe("");

    guard.compositionStart();
    guard.beforeInput(inputEvent("世界", "insertText", true));

    expect(guard.filterData("你好世界")).toBe("世界");
  });

  it("keeps printable ascii history when trimming cumulative IME data", () => {
    const guard = createTerminalImeGuard({ enabled: true });

    guard.compositionStart();
    expect(guard.filterData("你好")).toBe("你好");
    guard.compositionEnd({ data: "你好" });
    expect(guard.filterData("你好")).toBe("");
    expect(guard.filterData(" ")).toBe(" ");

    guard.compositionStart();

    expect(guard.filterData("你好 你好")).toBe("你好");
  });

  it("restores the full IME candidate when xterm emits only its suffix", () => {
    const logger = vi.fn();
    const guard = createTerminalImeGuard({ enabled: true, logger });

    guard.compositionStart();
    guard.beforeInput(inputEvent("你好", "insertText", true));

    expect(guard.filterData("好")).toBe("你好");
    expect(logger).toHaveBeenCalledWith("ime.suffix.restore", {
      source: "beforeinput",
      dataLength: 1,
      candidateLength: 2,
    });
  });

  it("drops a repeated candidate suffix after the full candidate was forwarded", () => {
    const logger = vi.fn();
    const guard = createTerminalImeGuard({ enabled: true, logger });

    guard.compositionStart();
    guard.input(inputEvent("你好", "insertText", true));
    expect(guard.filterData("你好")).toBe("你好");
    guard.compositionEnd({ data: "你好" });

    expect(guard.filterData("好")).toBe("");
    expect(logger).toHaveBeenCalledWith("ime.suffix.drop", {
      source: "compositionend",
      dataLength: 1,
      candidateLength: 2,
    });
  });

  it("keeps a separated repeated IME word intact after a space", () => {
    const guard = createTerminalImeGuard({ enabled: true });

    guard.compositionStart();
    guard.input(inputEvent("你好", "insertText", true));
    expect(guard.filterData("你好")).toBe("你好");
    guard.compositionEnd({ data: "你好" });
    expect(guard.filterData("你好")).toBe("");
    expect(guard.filterData(" ")).toBe(" ");

    guard.compositionStart();
    guard.beforeInput(inputEvent("你好", "insertText", true));
    expect(guard.filterData("好")).toBe("你好");
    guard.compositionEnd({ data: "你好" });
    expect(guard.filterData("好")).toBe("");
  });

  it("expires stale duplicate candidates", () => {
    const time = clock();
    const guard = createTerminalImeGuard({ enabled: true, now: time.now });

    guard.compositionStart();
    guard.input(inputEvent("好", "insertText", true));

    expect(guard.filterData("好")).toBe("好");

    guard.compositionEnd({ data: "好" });
    time.advance(300);

    expect(guard.filterData("好")).toBe("好");
  });

  it("ignores normal ascii input outside composition", () => {
    const guard = createTerminalImeGuard({ enabled: true });

    guard.input(inputEvent("a", "insertText", false));

    expect(guard.filterData("a")).toBe("a");
    expect(guard.filterData("a")).toBe("a");
  });

  it("clears the textarea after xterm has handled compositionend", () => {
    vi.useFakeTimers();
    try {
      const textarea = document.createElement("textarea");
      textarea.value = "你好";
      const logger = vi.fn();
      const guard = attachTerminalImeGuard({
        textarea,
        enabled: true,
        logger,
      });

      textarea.dispatchEvent(new CompositionEvent("compositionend", {
        data: "你好",
        bubbles: true,
      }));

      expect(textarea.value).toBe("你好");

      vi.runAllTimers();

      expect(textarea.value).toBe("");
      expect(logger).toHaveBeenCalledWith("ime.textarea.clear", {
        valueLength: 2,
      });

      guard.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not treat ascii typed after composition as duplicate IME data", () => {
    const guard = createTerminalImeGuard({ enabled: true });

    guard.compositionStart();
    guard.input(inputEvent("你", "insertText", true));
    expect(guard.filterData("你")).toBe("你");
    guard.compositionEnd({ data: "你" });
    expect(guard.filterData("你")).toBe("");

    guard.input(inputEvent("a", "insertText", false));

    expect(guard.filterData("a")).toBe("a");
    expect(guard.filterData("a")).toBe("a");
  });

  it("attaches DOM listeners and filters emitted data", () => {
    const textarea = document.createElement("textarea");
    const guard = attachTerminalImeGuard({
      textarea,
      enabled: true,
    });

    textarea.dispatchEvent(new CompositionEvent("compositionstart", {
      bubbles: true,
    }));
    textarea.dispatchEvent(new InputEvent("input", {
      inputType: "insertText",
      data: "测",
      isComposing: true,
      bubbles: true,
    }));

    expect(guard.filterData("测")).toBe("测");

    textarea.dispatchEvent(new CompositionEvent("compositionend", {
      data: "测",
      bubbles: true,
    }));

    expect(guard.filterData("测")).toBe("");

    guard.dispose();
  });
});
