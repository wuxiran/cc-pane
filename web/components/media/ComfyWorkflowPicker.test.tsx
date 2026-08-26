import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useComfyWorkflowTemplateStore } from "@/stores";
import ComfyWorkflowPicker from "./ComfyWorkflowPicker";

const workflow = JSON.stringify({
  "1": { class_type: "SaveImage", inputs: {} },
});

describe("ComfyWorkflowPicker", () => {
  beforeEach(() => {
    localStorage.removeItem("cc-panes-comfy-workflow-templates");
    useComfyWorkflowTemplateStore.setState({ templates: [] });
  });

  it("loads a saved workflow when selected without exposing its JSON", async () => {
    useComfyWorkflowTemplateStore.getState().saveTemplate("provider-1", "人像基础", workflow);
    const onChange = vi.fn();
    render(<ComfyWorkflowPicker providerId="provider-1" value="" onChange={onChange} />);

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.stringContaining("SaveImage")));
    expect(screen.getByTestId("comfy-ready-workflow-picker")).toBeInTheDocument();
    expect(screen.queryByText(/class_type/)).not.toBeInTheDocument();
  });

  it("imports an existing API workflow and remembers it as a preset", async () => {
    const onChange = vi.fn();
    render(<ComfyWorkflowPicker providerId="provider-1" value="" onChange={onChange} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([workflow], "portrait.json", { type: "application/json" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.stringContaining("SaveImage")));
    expect(useComfyWorkflowTemplateStore.getState().templates[0]?.name).toBe("portrait");
  });
});
