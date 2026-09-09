import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTerminalReplayPresentation } from "./terminalReplayPresentation";
import { createTerminalLayoutScheduler } from "./terminalLayoutScheduler";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  const host = document.createElement("div");
  host.style.position = "relative";
  const element = document.createElement("div");
  element.innerHTML = '<div id="original-row">已完成的结果</div><textarea></textarea>';
  host.appendChild(element);
  document.body.appendChild(host);
  element.getBoundingClientRect = () => ({ width: 960, height: 480 } as DOMRect);
  let lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
  const buffer = { type: "normal" as "normal" | "alternate", viewportY: 20, baseY: 80,
    getLine: (i: number) => ({ translateToString: () => lines[i] ?? "" }) };
  const term = { element, rows: 20, buffer: { active: buffer }, refresh: vi.fn(),
    scrollToBottom: vi.fn(() => { buffer.viewportY = buffer.baseY; }),
    scrollToLine: vi.fn((line: number) => { buffer.viewportY = line; }) };
  return { host, element, term, buffer, setLines: (next: string[]) => { lines = next; } };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("static replay presentation", () => {
  it("keeps the last frame visible while replay changes the live terminal, then restores the reading position", async () => {
    const { host, element, term, buffer } = setup();
    const gate = deferred();
    const done = withTerminalReplayPresentation(term, async () => {
      element.textContent = "正在重放旧进度";
      buffer.viewportY = 80;
      await gate.promise;
      element.textContent = "新结果";
      return 42;
    });
    const frame = host.querySelector(".cc-terminal-static-frame")!;
    expect(frame.textContent).toBe("已完成的结果");
    expect(frame.querySelector("textarea, [id]")).toBeNull();
    expect(element.style.opacity).toBe("0");
    await vi.advanceTimersByTimeAsync(500);
    expect(frame.isConnected).toBe(true);
    expect(element.style.opacity).toBe("0");
    gate.resolve();
    await vi.advanceTimersByTimeAsync(150);
    expect(await done).toBe(42);
    expect(host.querySelector(".cc-terminal-static-frame")).toBeNull();
    expect(element.style.opacity).toBe("");
    expect(buffer.viewportY).toBe(20);
    expect(host.hasAttribute("aria-busy")).toBe(false);
  });

  it("reanchors the reading position to retained content after older history is trimmed", async () => {
    const { term, buffer, setLines } = setup();
    const done = withTerminalReplayPresentation(term, async () => {
      setLines(Array.from({ length: 90 }, (_, i) => `line ${i + 10}`));
      buffer.baseY = 70;
      buffer.viewportY = 70;
    });
    await vi.advanceTimersByTimeAsync(150);
    await done;
    expect(buffer.viewportY).toBe(10);
  });

  it("keeps a terminal that was following output at the new bottom", async () => {
    const { term, buffer } = setup();
    buffer.viewportY = 80;
    const done = withTerminalReplayPresentation(term, async () => { buffer.baseY = 150; });
    await vi.advanceTimersByTimeAsync(150);
    await done;
    expect(buffer.viewportY).toBe(150);
  });

  it("keeps the frame through nested replay and the final live-output drain", async () => {
    const { term, host, element } = setup();
    const drain = deferred();
    const done = withTerminalReplayPresentation(term, async () => {
      await withTerminalReplayPresentation(term, async () => { element.textContent = "snapshot"; });
      await drain.promise;
    });
    await vi.advanceTimersByTimeAsync(150);
    expect(host.querySelectorAll(".cc-terminal-static-frame")).toHaveLength(1);
    expect(element.style.opacity).toBe("0");
    drain.resolve();
    await vi.advanceTimersByTimeAsync(150);
    await done;
    expect(element.style.opacity).toBe("");
  });

  it("does not reveal a second recovery that begins while the first is waiting for paint", async () => {
    const { term, host, element } = setup();
    const first = withTerminalReplayPresentation(term, async () => {});
    await Promise.resolve();
    const gate = deferred();
    const second = withTerminalReplayPresentation(term, () => gate.promise);
    await vi.advanceTimersByTimeAsync(150);
    await first;
    expect(host.querySelectorAll(".cc-terminal-static-frame")).toHaveLength(1);
    expect(element.style.opacity).toBe("0");
    gate.resolve();
    await vi.advanceTimersByTimeAsync(150);
    await second;
    expect(host.querySelector(".cc-terminal-static-frame")).toBeNull();
    expect(element.style.opacity).toBe("");
  });

  it("releases the frame on failure without hiding the original error", async () => {
    const { term, host, element } = setup();
    const failure = new Error("replay failed");
    const result = withTerminalReplayPresentation(term, async () => { throw failure; }).catch(e => e);
    await vi.advanceTimersByTimeAsync(150);
    expect(await result).toBe(failure);
    expect(host.querySelector(".cc-terminal-static-frame")).toBeNull();
    expect(element.style.opacity).toBe("");
  });

  it("does not depend on a running animation frame in a hidden window", async () => {
    const { term, host } = setup();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await withTerminalReplayPresentation(term, async () => {});
    expect(host.querySelector(".cc-terminal-static-frame")).toBeNull();
  });

  it("bounds the paint wait when the browser stops delivering frames", async () => {
    const { term, host } = setup();
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    const done = withTerminalReplayPresentation(term, async () => {});
    await vi.advanceTimersByTimeAsync(150);
    await done;
    expect(host.querySelector(".cc-terminal-static-frame")).toBeNull();
  });

  it("defers and coalesces Fit requests until replay finishes, then preserves the reading position", async () => {
    const { term, host, element, buffer } = setup();
    host.getBoundingClientRect = element.getBoundingClientRect;
    const fit = { fit: vi.fn(), proposeDimensions: () => ({ cols: 80, rows: 20 }) };
    const scheduler = createTerminalLayoutScheduler({
      getTerminal: () => Object.assign(term, { cols: 80 }) as unknown as Terminal,
      getHost: () => host, getFitAddon: () => fit as unknown as FitAddon,
      getSessionId: () => "s1", isActive: () => true,
      repaint: vi.fn(), resizeBackend: vi.fn(), logger: vi.fn(),
    });
    const gate = deferred();
    const done = withTerminalReplayPresentation(term, () => gate.promise);
    expect(scheduler.flush("context-menu.fit", { force: true })).toBeNull();
    expect(scheduler.flush("window.resize")).toBeNull();
    expect(fit.fit).not.toHaveBeenCalled();
    gate.resolve();
    await vi.advanceTimersByTimeAsync(150);
    await done;
    expect(fit.fit).toHaveBeenCalledOnce();
    expect(buffer.viewportY).toBe(20);
    scheduler.dispose();
  });

  it("uses readable static text if WebGL stops producing render events", async () => {
    const { term, element, host } = setup();
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    screen.appendChild(document.createElement("canvas"));
    element.appendChild(screen);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as never);
    const onRender = vi.fn(() => ({ dispose: vi.fn() }));
    const gate = deferred();
    const replay = vi.fn(() => gate.promise);
    const done = withTerminalReplayPresentation({ ...term, onRender }, replay);
    expect(replay).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(replay).toHaveBeenCalledOnce();
    expect(host.querySelector(".cc-terminal-static-frame pre")?.textContent).toContain("line 20");
    gate.resolve();
    await vi.advanceTimersByTimeAsync(150);
    await done;
    expect(element.style.opacity).toBe("");
  });
});
