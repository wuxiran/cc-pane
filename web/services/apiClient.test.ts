import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  apiDelete,
  apiGet,
  apiJson,
  invokeOrApi,
  isTauriRuntime,
  toQueryString,
} from "./apiClient";

const originalTauriInternals = window.__TAURI_INTERNALS__;

function setWebRuntime(): void {
  delete window.__TAURI_INTERNALS__;
}

function setTauriRuntime(): void {
  window.__TAURI_INTERNALS__ = {};
}

function mockFetch(response: Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() => Promise.resolve(response));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("apiClient", () => {
  beforeEach(() => {
    setTauriRuntime();
    vi.mocked(invoke).mockReset();
  });

  afterEach(() => {
    window.__TAURI_INTERNALS__ = originalTauriInternals;
    vi.unstubAllGlobals();
  });

  it("detects Tauri runtime from window internals", () => {
    expect(isTauriRuntime()).toBe(true);

    setWebRuntime();

    expect(isTauriRuntime()).toBe(false);
  });

  it("keeps invoke path in Tauri runtime", async () => {
    vi.mocked(invoke).mockResolvedValue("desktop-result");

    const result = await invokeOrApi("desktop_command", { id: "1" }, async () => "web-result");

    expect(invoke).toHaveBeenCalledWith("desktop_command", { id: "1" });
    expect(result).toBe("desktop-result");
  });

  it("uses api callback in web runtime", async () => {
    setWebRuntime();

    const result = await invokeOrApi("desktop_command", { id: "1" }, async () => "web-result");

    expect(invoke).not.toHaveBeenCalled();
    expect(result).toBe("web-result");
  });

  it("serializes query params while skipping nullish values", () => {
    expect(
      toQueryString({
        projectPath: "/tmp/project a",
        limit: 20,
        includeHidden: false,
        unused: undefined,
        empty: null,
      }),
    ).toBe("?projectPath=%2Ftmp%2Fproject+a&limit=20&includeHidden=false");
  });

  it("fetches JSON responses", async () => {
    const fetchMock = mockFetch(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await apiGet<{ ok: boolean }>("/api/example", { projectPath: "/tmp/p" });

    expect(fetchMock).toHaveBeenCalledWith("/api/example?projectPath=%2Ftmp%2Fp", undefined);
    expect(result).toEqual({ ok: true });
  });

  it("sends JSON request bodies", async () => {
    const fetchMock = mockFetch(
      new Response(JSON.stringify({ id: "created" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await apiJson<{ id: string }>("/api/example", "POST", { name: "demo" });

    expect(fetchMock).toHaveBeenCalledWith("/api/example", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "demo" }),
    });
    expect(result).toEqual({ id: "created" });
  });

  it("handles no-content responses", async () => {
    const fetchMock = mockFetch(new Response(null, { status: 204 }));

    await apiDelete("/api/example/1");

    expect(fetchMock).toHaveBeenCalledWith("/api/example/1", { method: "DELETE" });
  });

  it("throws response body for failed requests", async () => {
    mockFetch(new Response("bad request", { status: 400, statusText: "Bad Request" }));

    await expect(apiGet("/api/example")).rejects.toThrow("bad request");
  });
});
