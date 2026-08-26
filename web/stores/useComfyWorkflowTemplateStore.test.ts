import { beforeEach, describe, expect, it } from "vitest";
import { diffComfyWorkflows, normalizeComfyWorkflow } from "@/types/comfyWorkflowTemplate";
import { useComfyWorkflowTemplateStore } from "./useComfyWorkflowTemplateStore";

const workflow = JSON.stringify({
  "2": { class_type: "SaveImage", inputs: { filename_prefix: "demo" } },
  "1": { class_type: "KSampler", inputs: { seed: 1, sampler_name: "euler" } },
});
describe("useComfyWorkflowTemplateStore", () => {
  beforeEach(() => {
    useComfyWorkflowTemplateStore.setState({ templates: [] });
  });

  it("normalizes API workflows and appends versions to the selected template", () => {
    const first = useComfyWorkflowTemplateStore.getState().saveTemplate("provider-1", "Portrait", workflow, "a".repeat(64));
    expect(first.versions).toHaveLength(1);
    expect(first.versions[0].workflowJson.indexOf('"1"')).toBeLessThan(first.versions[0].workflowJson.indexOf('"2"'));

    const second = useComfyWorkflowTemplateStore.getState().saveTemplate(
      "provider-1",
      "Portrait",
      workflow.replace('"demo"', '"demo-v2"'),
      "b".repeat(64),
      first.id,
    );
    expect(second.id).toBe(first.id);
    expect(second.versions).toHaveLength(2);
    expect(second.versions[1].version).toBe(2);
    expect(useComfyWorkflowTemplateStore.getState().templates).toHaveLength(1);
  });

  it("does not duplicate an identical latest version", () => {
    const first = useComfyWorkflowTemplateStore.getState().saveTemplate("provider-1", "Portrait", workflow);
    const second = useComfyWorkflowTemplateStore.getState().saveTemplate("provider-1", "Portrait", workflow, null, first.id);
    expect(second.versions).toHaveLength(1);
  });

  it("rejects UI blueprints and invalid template names", () => {
    expect(() => normalizeComfyWorkflow({ nodes: [], links: [] })).toThrow("UI blueprint");
    expect(() => useComfyWorkflowTemplateStore.getState().saveTemplate("provider-1", "", workflow)).toThrow("template name");
    expect(() => useComfyWorkflowTemplateStore.getState().saveTemplate("provider-1", "Portrait", "{}"))
      .toThrow("workflow JSON");
  });

  it("reports structural node changes without depending on object key order", () => {
    const before = normalizeComfyWorkflow(workflow).workflow;
    const after = normalizeComfyWorkflow(JSON.stringify({
      "1": { class_type: "KSampler", inputs: { sampler_name: "euler", seed: 2 } },
      "3": { class_type: "PreviewImage", inputs: {} },
      "2": { class_type: "SaveImage", inputs: { filename_prefix: "demo" } },
    })).workflow;
    expect(diffComfyWorkflows(before, after, "a", "b")).toEqual({
      addedNodeIds: ["3"],
      removedNodeIds: [],
      changedNodeIds: ["1"],
      unchangedNodeCount: 1,
      schemaChanged: true,
    });
  });
});
