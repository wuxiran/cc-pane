import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mediaService } from "@/services/mediaService";
import ComfyResourcePanel from "./ComfyResourcePanel";

vi.mock("@/services/mediaService", () => ({
  mediaService: {
    getComfySystemStats: vi.fn(),
    freeComfyMemory: vi.fn(),
  },
}));

const service = vi.mocked(mediaService);

describe("ComfyResourcePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    service.getComfySystemStats.mockResolvedValue({
      providerId: "provider-1",
      schemaVersion: "comfy-system-stats-v1",
      system: { comfyuiVersion: "0.3.0", pytorchVersion: "2.6", ramFree: 8 * 1024 ** 3, ramTotal: 16 * 1024 ** 3 },
      devices: [{ name: "RTX Test", deviceType: "cuda", vramFree: 4 * 1024 ** 3, vramTotal: 8 * 1024 ** 3 }],
    });
    service.freeComfyMemory.mockResolvedValue({ providerId: "provider-1", unloadModels: true, freeMemory: true, accepted: true });
  });

  it("shows device resources and releases memory through the adapter contract", async () => {
    render(<ComfyResourcePanel providerId="provider-1" protocol="comfyui" />);
    await waitFor(() => expect(screen.getByText("RTX Test")).toBeInTheDocument());
    expect(screen.getByTestId("comfy-resource-panel")).toHaveTextContent("0.3.0");
    fireEvent.click(screen.getByRole("button", { name: "卸载模型" }));
    await waitFor(() => expect(service.freeComfyMemory).toHaveBeenCalledWith("provider-1", { unloadModels: true, freeMemory: true }));
  });

  it("does not render for non-Comfy protocols", () => {
    const { container } = render(<ComfyResourcePanel providerId="provider-1" protocol="open_ai_compatible" />);
    expect(container).toBeEmptyDOMElement();
    expect(service.getComfySystemStats).not.toHaveBeenCalled();
  });
});
