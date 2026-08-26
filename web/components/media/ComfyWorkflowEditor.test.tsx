import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComfyObjectInfoResponse } from "@/types/media";
import { useComfySchemaStore, useComfyWorkflowTemplateStore } from "@/stores";
import { mediaService } from "@/services/mediaService";
import ComfyWorkflowEditor from "./ComfyWorkflowEditor";

vi.mock("@/services/mediaService", () => ({
  mediaService: { getComfyObjectInfo: vi.fn() },
}));

const service = vi.mocked(mediaService);
const schema: ComfyObjectInfoResponse = {
  providerId: "provider-1",
  schemaFingerprint: "b".repeat(64),
  schemaVersion: "comfy-object-info-v1",
  schema: {
    LoadImage: {
      display_name: "Load Image",
      input: { required: { image: ["IMAGE", { tooltip: "Input image" }] } },
    },
  },
};

describe("ComfyWorkflowEditor", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    useComfySchemaStore.setState({ entries: {} });
    localStorage.removeItem("cc-panes-comfy-workflow-templates");
    useComfyWorkflowTemplateStore.setState({ templates: [] });
    await useComfyWorkflowTemplateStore.persist.rehydrate();
    service.getComfyObjectInfo.mockResolvedValue(schema);
  });

  it("discovers node controls and binds, switches, and unbinds staged references", async () => {
    let value = JSON.stringify({ "1": { class_type: "LoadImage", inputs: { image: "" } } });
    const onChange = vi.fn((next: string) => { value = next; });
    const { rerender } = render(
      <ComfyWorkflowEditor
        providerId="provider-1"
        referenceCount={2}
        referenceNames={["first.png", "second.png"]}
        value={value}
        onChange={onChange}
      />,
    );

    await waitFor(() => expect(screen.getByText("节点参数")).toBeInTheDocument());
    expect(screen.getByRole("combobox", { name: "工作流节点" })).toHaveTextContent("Load Image");
    const bindButton = screen.getByRole("button", { name: "绑定参考素材" });
    fireEvent.click(bindButton);
    expect(onChange).toHaveBeenCalledWith(expect.stringContaining("{{input:0}}"));
    rerender(<ComfyWorkflowEditor providerId="provider-1" referenceCount={2} referenceNames={["first.png", "second.png"]} value={value} onChange={onChange} />);

    const referenceSelect = screen.getByRole("combobox", { name: "选择参考素材" });
    fireEvent.click(referenceSelect);
    fireEvent.click(await screen.findByRole("option", { name: "#2 second.png" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.stringContaining("{{input:1}}"));
    rerender(<ComfyWorkflowEditor providerId="provider-1" referenceCount={2} referenceNames={["first.png", "second.png"]} value={value} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "解除参考素材绑定" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.stringContaining('"inputs": {}'));
  });

  it("discovers semantic branches and filters the editable node list", async () => {
    service.getComfyObjectInfo.mockResolvedValue({
      ...schema,
      schema: {
        LoraLoader: { display_name: "Load LoRA", input: { required: { strength_model: ["FLOAT", { default: 1 }] } } },
        ControlNetApplyAdvanced: { display_name: "Apply ControlNet", input: { required: { strength: ["FLOAT", { default: 1 }] } } },
        IPAdapterApply: { search_aliases: ["IP-Adapter"], input: { required: { weight: ["FLOAT", { default: 1 }] } } },
      },
    });
    const value = JSON.stringify({
      "1": { class_type: "LoraLoader", inputs: { strength_model: 1 } },
      "2": { class_type: "ControlNetApplyAdvanced", inputs: { strength: 1 } },
      "3": { class_type: "IPAdapterApply", inputs: { weight: 1 } },
    });
    render(<ComfyWorkflowEditor providerId="provider-1" value={value} onChange={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId("comfy-branch-discovery")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /LoRA/ })).toHaveTextContent("1/1");
    fireEvent.click(screen.getByRole("button", { name: /ControlNet/ }));
    expect(screen.getByRole("combobox", { name: "工作流节点" })).toHaveTextContent("Apply ControlNet");
    fireEvent.click(screen.getByRole("button", { name: /IP-Adapter/ }));
    expect(screen.getByRole("combobox", { name: "工作流节点" })).toHaveTextContent("IPAdapterApply");
  });

  it("saves, selects, and loads a provider-scoped workflow template", async () => {
    const workflow = JSON.stringify({ "1": { class_type: "LoadImage", inputs: { image: "" } } });
    const onChange = vi.fn();
    render(<ComfyWorkflowEditor providerId="provider-1" value={workflow} onChange={onChange} />);

    await waitFor(() => expect(screen.getByTestId("comfy-workflow-template-controls")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "保存工作流模板" }));
    fireEvent.change(screen.getByLabelText("模板名称"), { target: { value: "Portrait base" } });
    fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));

    const templateSelect = screen.getByRole("combobox", { name: "选择工作流模板" });
    await waitFor(() => expect(templateSelect).toHaveTextContent("Portrait base"));
    fireEvent.click(templateSelect);
    fireEvent.click(await screen.findByRole("option", { name: /Portrait base/ }));
    fireEvent.click(screen.getByRole("button", { name: "加载工作流模板" }));

    expect(onChange).toHaveBeenLastCalledWith(expect.stringContaining('"class_type": "LoadImage"'));
    expect(useComfyWorkflowTemplateStore.getState().templates[0]?.providerId).toBe("provider-1");
  });
});
