import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { saveClipboardImageMock, tauriReadTextMock } = vi.hoisted(() => ({
  saveClipboardImageMock: vi.fn(),
  tauriReadTextMock: vi.fn(),
}));

vi.mock("@/services", () => ({
  screenshotService: {
    saveClipboardImage: saveClipboardImageMock,
  },
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: tauriReadTextMock,
}));

import {
  clipboardHasImage,
  isTerminalPasteShortcut,
  resolveTerminalPastePayload,
} from "./terminalClipboard";

function createClipboardData({
  text = "",
  items = [],
}: {
  text?: string;
  items?: Array<{ kind: string; type: string }>;
}) {
  return {
    items,
    getData: vi.fn((type: string) => (type === "text/plain" ? text : "")),
  } as unknown as DataTransfer;
}

function createKeyboardEvent(
  key: string,
  options: {
    ctrlKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
  } = {}
): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key,
    ctrlKey: options.ctrlKey ?? false,
    shiftKey: options.shiftKey ?? false,
    altKey: options.altKey ?? false,
    metaKey: options.metaKey ?? false,
    bubbles: true,
    cancelable: true,
  });
}

describe("terminalClipboard", () => {
  const webReadTextMock = vi.fn();

  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: webReadTextMock,
      },
    });
  });

  afterEach(() => {
    saveClipboardImageMock.mockReset();
    tauriReadTextMock.mockReset();
    webReadTextMock.mockReset();
  });

  it("detects image clipboard items", () => {
    expect(
      clipboardHasImage(
        createClipboardData({
          items: [{ kind: "file", type: "image/png" }],
        })
      )
    ).toBe(true);

    expect(
      clipboardHasImage(
        createClipboardData({
          items: [{ kind: "string", type: "text/plain" }],
        })
      )
    ).toBe(false);
  });

  it("identifies native paste shortcuts that should bypass xterm key handling", () => {
    expect(isTerminalPasteShortcut(createKeyboardEvent("v", { ctrlKey: true }))).toBe(true);
    expect(isTerminalPasteShortcut(createKeyboardEvent("V", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isTerminalPasteShortcut(createKeyboardEvent("v", { metaKey: true }))).toBe(true);
    expect(isTerminalPasteShortcut(createKeyboardEvent("v", { ctrlKey: true, altKey: true }))).toBe(false);
    expect(isTerminalPasteShortcut(createKeyboardEvent("c", { ctrlKey: true }))).toBe(false);
  });

  it("prefers clipboard images and returns the saved file path", async () => {
    saveClipboardImageMock.mockResolvedValue({
      filePath: "C:/shots/screenshot_1.png",
      width: 10,
      height: 10,
    });

    const result = await resolveTerminalPastePayload(
      createClipboardData({
        text: "ignored text",
        items: [{ kind: "file", type: "image/png" }],
      })
    );

    expect(saveClipboardImageMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      kind: "image",
      text: "C:/shots/screenshot_1.png",
      filePath: "C:/shots/screenshot_1.png",
    });
  });

  it("falls back to plain text when the clipboard does not contain an image", async () => {
    const result = await resolveTerminalPastePayload(
      createClipboardData({
        text: "hello world",
        items: [{ kind: "string", type: "text/plain" }],
      })
    );

    expect(saveClipboardImageMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: "text",
      text: "hello world",
    });
  });

  it("reports an unavailable clipboard image when image paste was requested", async () => {
    saveClipboardImageMock.mockResolvedValue(null);

    const result = await resolveTerminalPastePayload(
      createClipboardData({
        items: [{ kind: "file", type: "image/png" }],
      })
    );

    expect(result).toEqual({
      kind: "error",
      reason: "clipboard-image-unavailable",
      error: "Clipboard image could not be read",
    });
  });

  it("reads text from the clipboard APIs when paste data is unavailable", async () => {
    saveClipboardImageMock.mockResolvedValue(null);
    webReadTextMock.mockResolvedValue("from web clipboard");

    const result = await resolveTerminalPastePayload(null);

    expect(saveClipboardImageMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      kind: "text",
      text: "from web clipboard",
    });
    expect(tauriReadTextMock).not.toHaveBeenCalled();
  });

  it("returns a save failure when persisting a clipboard image errors", async () => {
    saveClipboardImageMock.mockRejectedValue(new Error("disk full"));

    const result = await resolveTerminalPastePayload(
      createClipboardData({
        items: [{ kind: "file", type: "image/png" }],
      })
    );

    expect(result).toEqual({
      kind: "error",
      reason: "clipboard-image-save-failed",
      error: "disk full",
    });
  });
});
