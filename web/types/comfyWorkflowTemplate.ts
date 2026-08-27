import { parseComfyWorkflow, type ComfyWorkflow } from "./media";

export const COMFY_WORKFLOW_TEMPLATE_STORE_VERSION = 1;
export const COMFY_WORKFLOW_TEMPLATE_MAX_VERSIONS = 20;
export const COMFY_WORKFLOW_TEMPLATE_MAX_NAME_LENGTH = 128;
export const COMFY_WORKFLOW_TEMPLATE_MAX_BYTES = 1024 * 1024;

export interface ComfyWorkflowTemplateVersion {
  id: string;
  version: number;
  workflowJson: string;
  schemaFingerprint?: string | null;
  savedAt: string;
}
export interface ComfyWorkflowTemplate {
  id: string;
  providerId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  versions: ComfyWorkflowTemplateVersion[];
}

export interface ComfyWorkflowDiff {
  addedNodeIds: string[];
  removedNodeIds: string[];
  changedNodeIds: string[];
  unchangedNodeCount: number;
  schemaChanged: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}

function canonicalNode(node: unknown): string {
  return JSON.stringify(sortJson(node));
}

function cloneWorkflow(workflow: ComfyWorkflow): ComfyWorkflow {
  return JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;
}

export function workflowJson(value: ComfyWorkflow): string {
  return JSON.stringify(sortJson(value), null, 2);
}

/** Parse an API workflow and return a deterministic JSON representation. */
export function normalizeComfyWorkflow(value: string | unknown): {
  workflow: ComfyWorkflow;
  json: string;
} {
  let parsed: unknown = value;
  if (typeof value === "string") {
    if (new TextEncoder().encode(value).byteLength > COMFY_WORKFLOW_TEMPLATE_MAX_BYTES) {
      throw new Error("workflow is too large");
    }
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("workflow JSON is invalid");
    }
  }
  const result = parseComfyWorkflow(parsed);
  if (!result.workflow) {
    throw new Error(result.error === "ui_format" ? "UI blueprint is not an API workflow" : "workflow JSON is invalid");
  }
  const workflow = cloneWorkflow(result.workflow);
  const json = workflowJson(workflow);
  if (new TextEncoder().encode(json).byteLength > COMFY_WORKFLOW_TEMPLATE_MAX_BYTES) {
    throw new Error("workflow is too large");
  }
  return { workflow, json };
}

export function diffComfyWorkflows(
  before: ComfyWorkflow,
  after: ComfyWorkflow,
  beforeSchemaFingerprint?: string | null,
  afterSchemaFingerprint?: string | null,
): ComfyWorkflowDiff {
  const beforeIds = new Set(Object.keys(before));
  const afterIds = new Set(Object.keys(after));
  const addedNodeIds = [...afterIds].filter((id) => !beforeIds.has(id)).sort();
  const removedNodeIds = [...beforeIds].filter((id) => !afterIds.has(id)).sort();
  const changedNodeIds = [...afterIds]
    .filter((id) => beforeIds.has(id) && canonicalNode(before[id]) !== canonicalNode(after[id]))
    .sort();
  const unchangedNodeCount = [...afterIds]
    .filter((id) => beforeIds.has(id) && canonicalNode(before[id]) === canonicalNode(after[id]))
    .length;
  return {
    addedNodeIds,
    removedNodeIds,
    changedNodeIds,
    unchangedNodeCount,
    schemaChanged: Boolean(beforeSchemaFingerprint && afterSchemaFingerprint && beforeSchemaFingerprint !== afterSchemaFingerprint),
  };
}
