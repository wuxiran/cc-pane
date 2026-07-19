import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, saveClipboardImageMock, tauriReadTextMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  saveClipboardImageMock: vi.fn(),
  tauriReadTextMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
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
  formatTerminalFilePaths,
  readClipboardFilePaths,
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
    invokeMock.mockReset();
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

  it("prefers clipboard images and returns the saved file path", async () => {
    invokeMock.mockResolvedValue([]);
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
    invokeMock.mockResolvedValue([]);
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
    invokeMock.mockResolvedValue([]);
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

  it("reads text from the Tauri clipboard when paste data is unavailable", async () => {
    invokeMock.mockResolvedValue([]);
    saveClipboardImageMock.mockResolvedValue(null);
    tauriReadTextMock.mockResolvedValue("from tauri clipboard");

    const result = await resolveTerminalPastePayload(null);

    expect(saveClipboardImageMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      kind: "text",
      text: "from tauri clipboard",
    });
    expect(webReadTextMock).not.toHaveBeenCalled();
  });

  it("returns a save failure when persisting a clipboard image errors", async () => {
    invokeMock.mockResolvedValue([]);
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

  it("still pastes text when the clipboard image probe throws", async () => {
    // Linux: `screenshot_save_clipboard_image` reads the clipboard off the main
    // thread and the invoke can be rejected outright. Text paste must survive.
    invokeMock.mockResolvedValue([]);
    saveClipboardImageMock.mockRejectedValue(new Error("clipboard image read failed"));
    tauriReadTextMock.mockResolvedValue("plain text from clipboard");

    const result = await resolveTerminalPastePayload(null);

    expect(saveClipboardImageMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      kind: "text",
      text: "plain text from clipboard",
    });
  });

  it("still pastes text when the image probe throws on an event-driven paste", async () => {
    invokeMock.mockResolvedValue([]);
    saveClipboardImageMock.mockRejectedValue(new Error("clipboard image read failed"));

    const result = await resolveTerminalPastePayload(
      createClipboardData({
        text: "hello world",
        items: [{ kind: "file", type: "image/png" }],
      })
    );

    expect(result).toEqual({
      kind: "text",
      text: "hello world",
    });
  });

  it("reports the image failure only when no text is available", async () => {
    invokeMock.mockResolvedValue([]);
    saveClipboardImageMock.mockRejectedValue(new Error("disk full"));
    tauriReadTextMock.mockResolvedValue("");
    webReadTextMock.mockResolvedValue("");

    const result = await resolveTerminalPastePayload(null);

    expect(result).toEqual({
      kind: "error",
      reason: "clipboard-image-save-failed",
      error: "disk full",
    });
  });

  it("formats dropped or pasted file paths with spaces between entries", () => {
    expect(formatTerminalFilePaths([
      "/Users/me/Desktop/企业基本信息.sql",
      "/Users/me/Desktop/second.sql",
    ])).toBe("/Users/me/Desktop/企业基本信息.sql /Users/me/Desktop/second.sql");
  });

  it("prefers clipboard file paths over plain text", async () => {
    invokeMock.mockResolvedValue([
      "/Users/me/Desktop/企业基本信息.sql",
      "/Users/me/Desktop/second.sql",
    ]);

    const result = await resolveTerminalPastePayload(
      createClipboardData({
        text: "企业基本信息.sql",
        items: [{ kind: "string", type: "text/plain" }],
      })
    );

    expect(result).toEqual({
      kind: "file",
      text: "/Users/me/Desktop/企业基本信息.sql /Users/me/Desktop/second.sql",
      filePaths: [
        "/Users/me/Desktop/企业基本信息.sql",
        "/Users/me/Desktop/second.sql",
      ],
    });
    expect(saveClipboardImageMock).not.toHaveBeenCalled();
  });

  it("returns a structured file path read error", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    invokeMock.mockRejectedValue(new Error("clipboard unavailable"));

    const result = await readClipboardFilePaths();

    expect(result).toEqual({
      paths: [],
      error: "clipboard unavailable",
    });
    expect(debugSpy).toHaveBeenCalledWith(
      "[terminalClipboard] clipboard.file-paths.failed",
      { error: "clipboard unavailable" }
    );
    debugSpy.mockRestore();
  });

  it("falls back when reading clipboard file paths fails", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    invokeMock.mockRejectedValue(new Error("clipboard unavailable"));

    const result = await resolveTerminalPastePayload(
      createClipboardData({
        text: "hello world",
        items: [{ kind: "string", type: "text/plain" }],
      })
    );

    expect(result).toEqual({
      kind: "text",
      text: "hello world",
    });
    expect(debugSpy).toHaveBeenCalledWith(
      "[terminalClipboard] clipboard.file-paths.failed",
      { error: "clipboard unavailable" }
    );
    debugSpy.mockRestore();
  });
});
