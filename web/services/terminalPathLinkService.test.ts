import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import i18n from "@/i18n";
import { translateError } from "@/utils";
import { terminalPathLinkService } from "./terminalPathLinkService";

const originalTauriInternals = window.__TAURI_INTERNALS__;

describe("terminalPathLinkService", () => {
  beforeEach(() => {
    window.__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockReset();
  });

  afterEach(() => {
    window.__TAURI_INTERNALS__ = originalTauriInternals;
    vi.unstubAllGlobals();
  });

  it("resolves through the desktop command in Tauri", async () => {
    const resolved = { canonicalPath: "C:/repo/src/App.tsx", kind: "file", runtimeKind: "local" } as const;
    vi.mocked(invoke).mockResolvedValue(resolved);

    await expect(terminalPathLinkService.resolve({ sessionId: "s1", rawPath: "src/App.tsx" }))
      .resolves.toEqual(resolved);
    expect(invoke).toHaveBeenCalledWith("resolve_terminal_path_link", {
      sessionId: "s1",
      rawPath: "src/App.tsx",
    });
  });

  it("resolves through the authenticated Web route outside Tauri", async () => {
    delete window.__TAURI_INTERNALS__;
    const resolved = { canonicalPath: "/repo/src/App.tsx", kind: "file", runtimeKind: "local" };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(resolved), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(terminalPathLinkService.resolve({ sessionId: "s1", rawPath: "src/App.tsx" }))
      .resolves.toEqual(resolved);
    expect(fetchMock).toHaveBeenCalledWith("/api/terminal/path-link/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", rawPath: "src/App.tsx" }),
    });
  });

  it("fails closed for desktop actions in Web mode", async () => {
    delete window.__TAURI_INTERNALS__;

    await expect(terminalPathLinkService.runDesktopAction({
      sessionId: "s1",
      rawPath: "src/App.tsx",
      action: "reveal",
    })).rejects.toMatchObject({ code: "TERMINAL_PATH_ACTION_UNSUPPORTED" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("translates a structured Web resolver error by its stable code", async () => {
    delete window.__TAURI_INTERNALS__;
    await i18n.changeLanguage("en");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: "TERMINAL_PATH_OUTSIDE_ROOT",
      message: "backend fallback must not be shown",
    }), { status: 400 })));

    const error = await terminalPathLinkService.resolve({
      sessionId: "s1",
      rawPath: "../outside.md",
    }).catch((caught) => caught);

    expect(translateError(error)).toBe("This path is outside the terminal project");
  });
});
