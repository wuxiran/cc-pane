export const COMFY_OBJECT_INFO_SCHEMA_VERSION = "comfy-object-info-v1";
export const COMFY_WORKFLOW_SCHEMA_VERSION = "comfy-api-v1";

/** Raw input tuple returned by ComfyUI's `/object_info` endpoint. */
export type ComfyInputSpec = [unknown, Record<string, unknown>?];

export interface ComfyNodeInputGroups {
  required?: Record<string, ComfyInputSpec>;
  optional?: Record<string, ComfyInputSpec>;
  hidden?: Record<string, ComfyInputSpec>;
}

/** ComfyUI keeps these fields snake_case; retain unknown custom-node fields. */
export interface ComfyNodeDefinition {
  input?: ComfyNodeInputGroups;
  output?: unknown[];
  output_name?: string[];
  display_name?: string;
  name?: string;
  category?: string;
  description?: string;
  /** ComfyUI's searchable aliases (the API uses snake_case). */
  search_aliases?: string[];
  searchAliases?: string[];
  deprecated?: boolean;
  [key: string]: unknown;
}

/** Semantic branches surfaced by ComfyUI's model/conditioning nodes. */
export type ComfyNodeBranch = "lora" | "controlnet" | "ipAdapter";

/** Resolve a node's semantic branch from ComfyUI's searchable metadata. */
export function classifyComfyNode(
  classType: string,
  definition?: ComfyNodeDefinition,
): ComfyNodeBranch | null {
  const aliases = [
    ...(Array.isArray(definition?.search_aliases) ? definition.search_aliases : []),
    ...(Array.isArray(definition?.searchAliases) ? definition.searchAliases : []),
  ];
  const text = [
    classType,
    definition?.display_name,
    definition?.name,
    definition?.category,
    definition?.description,
    ...aliases,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase()
    .replace(/[\u2010-\u2015_]+/g, "-");
  if (/ip\s*-?\s*adapter|ipadapter/.test(text)) return "ipAdapter";
  if (/control\s*-?\s*net|controlnet|t2i\s*-?\s*adapter/.test(text)) return "controlnet";
  if (/lora|lo\s*-?\s*ra/.test(text)) return "lora";
  return null;
}

export interface ComfyObjectInfoResponse {
  providerId: string;
  schemaFingerprint: string;
  schemaVersion: string;
  schema: Record<string, ComfyNodeDefinition>;
  node?: ComfyNodeDefinition | null;
}

export interface ComfySystemInfo {
  os?: string | null;
  ramTotal?: number | null;
  ramFree?: number | null;
  comfyuiVersion?: string | null;
  pythonVersion?: string | null;
  pytorchVersion?: string | null;
  embeddedPython?: boolean | null;
  deployEnvironment?: string | null;
}

export interface ComfyDeviceInfo {
  name?: string | null;
  deviceType?: string | null;
  index?: number | null;
  vramTotal?: number | null;
  vramFree?: number | null;
  torchVramTotal?: number | null;
  torchVramFree?: number | null;
}

export interface ComfySystemStats {
  providerId: string;
  schemaVersion: string;
  system: ComfySystemInfo;
  devices: ComfyDeviceInfo[];
}

export interface ComfyMemoryReleaseResult {
  providerId: string;
  unloadModels: boolean;
  freeMemory: boolean;
  accepted: boolean;
}

export interface ComfyWorkflowNode {
  class_type: string;
  inputs: Record<string, unknown>;
  [key: string]: unknown;
}

export type ComfyWorkflow = Record<string, ComfyWorkflowNode>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function looksLikeWorkflow(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && Object.keys(value).length > 0
    && Object.values(value).every((node) => isRecord(node) && typeof node.class_type === "string");
}

/** Parse and normalize a ComfyUI API prompt without accepting UI blueprints. */
export function parseComfyWorkflow(value: unknown): { workflow?: ComfyWorkflow; error?: "invalid" | "ui_format" } {
  if (!isRecord(value)) return { error: "invalid" };
  const candidate = looksLikeWorkflow(value.prompt) ? value.prompt : value;
  if (!isRecord(candidate) || "nodes" in candidate || "links" in candidate) return { error: "ui_format" };
  if (!looksLikeWorkflow(candidate)) return { error: "invalid" };
  const workflow: ComfyWorkflow = {};
  for (const [nodeId, rawNode] of Object.entries(candidate)) {
    if (!nodeId || nodeId.includes("/") || nodeId.includes("\\") || /[\u0000-\u001f]/.test(nodeId)) return { error: "invalid" };
    if (!isRecord(rawNode) || typeof rawNode.class_type !== "string" || !rawNode.class_type.trim() || rawNode.class_type.length > 256 || /[\u0000-\u001f]/.test(rawNode.class_type)) return { error: "invalid" };
    workflow[nodeId] = { ...rawNode, class_type: rawNode.class_type, inputs: isRecord(rawNode.inputs) ? rawNode.inputs : {} };
  }
  const edges: Record<string, string[]> = {};
  for (const [nodeId, node] of Object.entries(workflow)) {
    for (const input of Object.values(node.inputs)) {
      if (!Array.isArray(input) || input.length !== 2 || typeof input[1] !== "number" || !Number.isInteger(input[1]) || input[1] < 0) continue;
      const source = typeof input[0] === "string"
        ? input[0]
        : typeof input[0] === "number" && Number.isInteger(input[0]) ? String(input[0]) : null;
      if (source === null || (typeof input[0] === "number" && !workflow[source])) continue;
      if (!workflow[source]) return { error: "invalid" };
      (edges[source] ??= []).push(nodeId);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return false;
    if (visited.has(nodeId)) return true;
    visiting.add(nodeId);
    if (!(edges[nodeId] ?? []).every(visit)) return false;
    visiting.delete(nodeId);
    visited.add(nodeId);
    return true;
  };
  if (!Object.keys(workflow).every(visit)) return { error: "invalid" };
  return { workflow };
}

/** Recursively sort JSON object keys while preserving array order. */
export function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalizeJson(value[key])]));
  return value;
}

/** SHA-256 fingerprint shared with the Rust ComfyUI adapter. */
export async function jsonFingerprint(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(canonicalizeJson(value)));
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", encoded);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  let hash = 2166136261;
  for (const byte of encoded) hash = Math.imul(hash ^ byte, 16777619);
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
