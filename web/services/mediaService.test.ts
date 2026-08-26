import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mediaService } from "./mediaService";

interface FakeSocket {
  url: string;
  readyState: number;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  close: ReturnType<typeof vi.fn>;
  emit(data: unknown): void;
}

class TestWebSocket implements FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: TestWebSocket[] = [];
  url: string;
  readyState = TestWebSocket.OPEN;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn(() => {
    this.readyState = TestWebSocket.CLOSED;
  });

  constructor(url: string) {
    this.url = url;
    TestWebSocket.instances.push(this);
  }

  emit(data: unknown): void {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }
}

describe("mediaService web event stream", () => {
  const originalInternals = window.__TAURI_INTERNALS__;

  beforeEach(() => {
    delete window.__TAURI_INTERNALS__;
    TestWebSocket.instances = [];
    vi.stubGlobal("WebSocket", TestWebSocket);
  });

  afterEach(() => {
    window.__TAURI_INTERNALS__ = originalInternals;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens the authenticated media socket, scopes events, and closes it", async () => {
    const handler = vi.fn();
    const cleanup = await mediaService.listen(handler, "workspace-a");
    const socket = TestWebSocket.instances[0];

    expect(socket?.url).toBe(`ws://${window.location.host}/ws/media?workspaceId=workspace-a`);
    socket?.emit({
      type: "media-job-changed",
      workspaceId: "workspace-a",
      runId: "run-a",
      nodeId: "node-a",
      status: "processing",
      progress: 42,
    });
    socket?.emit({
      type: "media-job-changed",
      workspaceId: "workspace-b",
      runId: "run-b",
      nodeId: "node-b",
      status: "succeeded",
    });
    socket?.emit("not-json-object");

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-a", progress: 42 }));

    cleanup();
    expect(socket?.close).toHaveBeenCalledTimes(1);
    socket?.emit({ runId: "run-late", nodeId: "node-late", status: "processing" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("degrades to a no-op cleanup when WebSocket is unavailable", async () => {
    vi.stubGlobal("WebSocket", undefined);
    const cleanup = await mediaService.listen(vi.fn(), "workspace-a");
    expect(() => cleanup()).not.toThrow();
  });

  it("posts replay overrides to the REST contract with a fresh idempotency key", async () => {
    const response = { id: "variant-run", status: "queued" };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(mediaService.replayRun("source/run", {
      prompt: "variant prompt",
      parameters: { seed: 99 },
      priority: 40,
    })).resolves.toEqual(response);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/media/runs/source%2Frun/replay");
    const body = JSON.parse(String(options.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ prompt: "variant prompt", parameters: { seed: 99 }, priority: 40 });
    expect(typeof body.clientRequestId).toBe("string");
    expect(String(body.clientRequestId)).not.toHaveLength(0);
  });

  it("loads provider capabilities with the selected media protocol", async () => {
    const response = {
      providerId: "provider-1",
      protocol: "comfyui",
      kinds: ["image", "video"],
      operations: ["textToImage", "imageToImage"],
      supportsAsyncJobs: true,
      supportsCancel: true,
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(mediaService.getProviderCapabilities("provider-1", "comfyui")).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/media/capabilities?providerId=provider-1&protocol=comfyui",
      undefined,
    );
  });

  it("loads ComfyUI resources and posts an explicit memory release request", async () => {
    const stats = {
      providerId: "provider-1",
      schemaVersion: "comfy-system-stats-v1",
      system: { ramFree: 8, ramTotal: 16 },
      devices: [{ name: "GPU", vramFree: 4, vramTotal: 8 }],
    };
    const release = { providerId: "provider-1", unloadModels: true, freeMemory: true, accepted: true };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(stats), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(release), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(mediaService.getComfySystemStats("provider-1")).resolves.toEqual(stats);
    await expect(mediaService.freeComfyMemory("provider-1", { unloadModels: true })).resolves.toEqual(release);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/media/comfy/system-stats?providerId=provider-1");
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      providerId: "provider-1",
      unloadModels: true,
      freeMemory: true,
    });
  });
});
