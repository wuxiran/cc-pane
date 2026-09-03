import "@/i18n";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProvidersStore } from "@/stores";
import type { Provider } from "@/types/provider";
import MediaProviderSection from "./MediaProviderSection";

vi.mock("@/services/providerService", () => ({
  providerService: {
    addProvider: vi.fn(),
    updateProvider: vi.fn(),
  },
}));

function provider(id: string, name: string): Provider {
  return {
    id,
    name,
    // Media providers are a dedicated type; the section filters LLM
    // providers out entirely (docs/99 B1).
    providerType: "media",
    apiKey: null,
    baseUrl: "https://api.example.com",
    models: [{ id: "model-1" }],
    defaultModelId: "model-1",
    isDefault: false,
  };
}

function renderSection(providerId: string | null, protocol: "open_ai_compatible" | "comfyui" = "open_ai_compatible") {
  return render(
    <MediaProviderSection
      providerId={providerId}
      modelId="model-1"
      protocol={protocol}
      onProviderChange={vi.fn()}
      onModelChange={vi.fn()}
      onProtocolChange={vi.fn()}
    />,
  );
}

describe("MediaProviderSection", () => {
  beforeEach(() => {
    useProvidersStore.setState({
      providers: [provider("comfy-local", "ComfyUI (local)"), provider("cloud-1", "Cloud Comfy")],
      loadProviders: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("lists cloud providers without exposing local runtime controls", async () => {
    renderSection("cloud-1", "comfyui");

    fireEvent.click(screen.getByRole("combobox", { name: "Provider" }));
    const listbox = await screen.findByRole("listbox");
    expect(within(listbox).getByRole("option", { name: "Cloud Comfy" })).toBeInTheDocument();
    expect(within(listbox).queryByRole("option", { name: /ComfyUI.*local/i })).not.toBeInTheDocument();
    expect(screen.queryByText("运行时资源")).not.toBeInTheDocument();
    expect(screen.queryByText("本地引擎未运行")).not.toBeInTheDocument();
  });

  it("migrates a persisted local provider selection to a cloud provider", async () => {
    const onProviderChange = vi.fn();
    render(
      <MediaProviderSection
        providerId="comfy-local"
        modelId={null}
        protocol="comfyui"
        onProviderChange={onProviderChange}
        onModelChange={vi.fn()}
        onProtocolChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(onProviderChange).toHaveBeenCalledWith("cloud-1"));
  });
});
