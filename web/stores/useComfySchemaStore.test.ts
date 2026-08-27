import { beforeEach, describe, expect, it, vi } from "vitest";
import { mediaService } from "@/services/mediaService";
import type { ComfyObjectInfoResponse } from "@/types/media";
import { useComfySchemaStore } from "./useComfySchemaStore";

vi.mock("@/services/mediaService", () => ({
  mediaService: { getComfyObjectInfo: vi.fn() },
}));

const service = vi.mocked(mediaService);
const schema: ComfyObjectInfoResponse = {
  providerId: "provider-1",
  schemaFingerprint: "a".repeat(64),
  schemaVersion: "comfy-object-info-v1",
  schema: { SaveImage: { input: { required: {} } } },
};

describe("useComfySchemaStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useComfySchemaStore.setState({ entries: {} });
  });

  it("caches a provider schema until explicitly refreshed", async () => {
    service.getComfyObjectInfo.mockResolvedValue(schema);
    await useComfySchemaStore.getState().load("provider-1");
    await useComfySchemaStore.getState().load("provider-1");
    expect(service.getComfyObjectInfo).toHaveBeenCalledTimes(1);
    await useComfySchemaStore.getState().load("provider-1", true);
    expect(service.getComfyObjectInfo).toHaveBeenCalledTimes(2);
  });

  it("keeps the last schema and exposes a load error", async () => {
    service.getComfyObjectInfo.mockResolvedValueOnce(schema).mockRejectedValueOnce(new Error("offline"));
    await useComfySchemaStore.getState().load("provider-1");
    await useComfySchemaStore.getState().load("provider-1", true);
    expect(useComfySchemaStore.getState().entries["provider-1"]).toMatchObject({
      data: schema,
      loading: false,
      error: "offline",
    });
  });
});
