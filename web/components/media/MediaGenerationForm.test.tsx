import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MediaGenerationForm from "./MediaGenerationForm";

describe("MediaGenerationForm", () => {
  it("hides SD tuning fields for the OpenAI-compatible protocol and submits base parameters", async () => {
    const onGenerate = vi.fn().mockResolvedValue(undefined);
    render(
      <MediaGenerationForm
        kind="image"
        providerId="provider-1"
        modelId="model-1"
        protocol="open_ai_compatible"
        onGenerate={onGenerate}
      />,
    );

    // SD-only knobs never render outside the ComfyUI protocol (docs/99 P0);
    // the backend additionally whitelists the wire body.
    expect(screen.queryByLabelText("负面提示词")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("采样步数")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("引导强度")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Seed")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("提示词"), { target: { value: "a red kite" } });
    fireEvent.change(screen.getByLabelText("张数"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "生成图片" }));

    await waitFor(() => expect(onGenerate).toHaveBeenCalledTimes(1));
    expect(onGenerate).toHaveBeenCalledWith(expect.objectContaining({
      operation: "textToImage",
      prompt: "a red kite",
      priority: 0,
      parameters: expect.objectContaining({
        n: 3,
        batchSize: 3,
        seedMode: "random",
      }),
    }));
  });

  it("hides tuning fields the sub2api task protocol does not accept", () => {
    render(
      <MediaGenerationForm
        kind="image"
        providerId="provider-1"
        modelId="model-1"
        protocol="sub2api"
        onGenerate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByLabelText("提示词")).toBeInTheDocument();
    expect(screen.getByLabelText("张数")).toBeInTheDocument();
    expect(screen.queryByLabelText("负面提示词")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("采样步数")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("引导强度")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Seed")).not.toBeInTheDocument();
  });

  it("filters generation modes to the adapter capability contract", () => {
    render(
      <MediaGenerationForm
        kind="image"
        providerId="provider-1"
        modelId="model-1"
        capabilities={{
          providerId: "provider-1",
          protocol: "open_ai_compatible",
          kinds: ["image"],
          operations: ["textToImage"],
          supportsAsyncJobs: true,
          supportsCancel: false,
        }}
        onGenerate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByRole("button", { name: "文生图" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "图生图" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "局部编辑" })).not.toBeInTheDocument();
  });

  it("uses a generated image as the first input for image-to-video", async () => {
    const onGenerate = vi.fn().mockResolvedValue(undefined);
    render(
      <MediaGenerationForm
        kind="video"
        providerId="provider-1"
        modelId="model-1"
        linkedInput={{
          assetId: "upstream-image",
          sourceNodeId: "source-node",
          sourceRunId: "source-run",
          mediaKind: "image",
          name: "hero.png",
          mimeType: "image/png",
        }}
        onGenerate={onGenerate}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("linked-media-input")).toHaveTextContent("hero.png"));
    fireEvent.change(screen.getByLabelText("提示词"), { target: { value: "slow dolly in" } });
    fireEvent.click(screen.getByRole("button", { name: "生成视频" }));

    await waitFor(() => expect(onGenerate).toHaveBeenCalledTimes(1));
    expect(onGenerate).toHaveBeenCalledWith(expect.objectContaining({
      operation: "imageToVideo",
      inputAssetIds: ["upstream-image"],
      linkedInput: expect.objectContaining({ sourceNodeId: "source-node", sourceRunId: "source-run" }),
      inputFiles: [],
      parameters: expect.objectContaining({ frameMode: "single" }),
    }));
  });
});
