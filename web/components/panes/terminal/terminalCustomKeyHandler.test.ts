import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { shouldTerminalHandleKey } from "@/stores";
import { createTerminalCustomKeyHandler } from "./terminalCustomKeyHandler";

const platform = vi.hoisted(() => ({ windows: true, mac: false }));
vi.mock("../terminalViewHelpers", () => ({
  get IS_WINDOWS() { return platform.windows; },
  get IS_MAC() { return platform.mac; },
}));
vi.mock("@/stores", () => ({ shouldTerminalHandleKey: vi.fn(() => true) }));
vi.mock("@/utils", () => ({ getErrorMessage: (error: unknown) => String(error) }));
vi.mock("../terminalClipboard", () => ({ copyTerminalSelection: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ toast: { error: vi.fn() } }));

const terminals: Terminal[] = [];
let TerminalClass: typeof Terminal;

beforeEach(async () => {
  platform.windows = true;
  platform.mac = false;
  vi.clearAllMocks();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: false, addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
  TerminalClass = (await import("@xterm/xterm")).Terminal;
});

afterEach(() => {
  terminals.splice(0).forEach(term => term.dispose());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function createTerminal(withApplicationHandler: boolean) {
  const term = new TerminalClass();
  terminals.push(term);
  const host = document.createElement("div");
  document.body.append(host);
  term.open(host);
  const data: string[] = [];
  term.onData(value => data.push(value));
  const guard = { handleKeyEvent: vi.fn(() => true), clearNativeEditState: vi.fn(), dispose: vi.fn() };
  const handler = createTerminalCustomKeyHandler({
    term, getImeGuard: () => guard, debugLog: vi.fn(), pasteTerminalPayload: vi.fn(),
  });
  if (withApplicationHandler) term.attachCustomKeyEventHandler(handler);
  return { term, data, handler, guard };
}

function imeKey() {
  const event = new KeyboardEvent("keydown", { key: "Process", bubbles: true, cancelable: true });
  Object.defineProperty(event, "keyCode", { value: 229 });
  return event;
}

describe("Windows input uses upstream xterm IME handling", () => {
  it.each(["，", "。", "！"])("forwards IME punctuation %s exactly like unmodified xterm", async text => {
    const upstream = createTerminal(false);
    const application = createTerminal(true);
    for (const { term } of [upstream, application]) {
      term.textarea!.dispatchEvent(imeKey());
      // IMEs can insert punctuation without starting a composition. Upstream
      // keyCode 229 handling observes the textarea after the native input event.
      term.textarea!.value = text;
      term.textarea!.dispatchEvent(new InputEvent("input", {
        data: text, inputType: "insertText", bubbles: true, composed: true,
      }));
    }
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(upstream.data).toEqual([text]);
    expect(application.data).toEqual(upstream.data);
    expect(shouldTerminalHandleKey).not.toHaveBeenCalled();
  });

  it("retains the WebKit workaround and gives the platform guard first refusal", () => {
    const { handler, guard } = createTerminal(true);
    platform.windows = false;
    platform.mac = true;
    expect(handler(imeKey())).toBe(false);
    platform.mac = false;
    expect(handler(imeKey())).toBe(false);
    platform.windows = true;
    guard.handleKeyEvent.mockReturnValue(false);
    expect(handler(imeKey())).toBe(false);
    expect(shouldTerminalHandleKey).not.toHaveBeenCalled();
  });
});
