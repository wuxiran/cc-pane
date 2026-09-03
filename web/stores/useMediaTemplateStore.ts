import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { MediaKind } from "@/types/media";

/**
 * Canvas-level workflow templates: a reusable snapshot of node parameters and
 * edges (no assets, no run state). Cross-provider by design — unlike the
 * provider-scoped ComfyUI workflow templates.
 */
export interface MediaCanvasTemplateNode {
  title: string;
  kind: MediaKind;
  defaultOperation: string;
  parameters: Record<string, unknown>;
  providerRef?: { providerId: string; modelId: string } | null;
}

export interface MediaCanvasTemplateEdge {
  /** Indices into the template's `nodes` array. */
  sourceIndex: number;
  targetIndex: number;
  sourcePort: string;
  targetPort: string;
}

export interface MediaCanvasTemplate {
  id: string;
  name: string;
  createdAt: string;
  nodes: MediaCanvasTemplateNode[];
  edges: MediaCanvasTemplateEdge[];
}

interface MediaTemplateState {
  templates: MediaCanvasTemplate[];
  saveTemplate: (template: Omit<MediaCanvasTemplate, "id" | "createdAt">) => MediaCanvasTemplate;
  removeTemplate: (id: string) => void;
  /** Merge imported templates; imported entries get fresh ids. */
  importTemplates: (imported: Array<Omit<MediaCanvasTemplate, "id" | "createdAt"> & Partial<Pick<MediaCanvasTemplate, "createdAt">>>) => number;
}

const MAX_TEMPLATES = 50;

function sanitizeTemplate(
  input: Omit<MediaCanvasTemplate, "id" | "createdAt"> & Partial<Pick<MediaCanvasTemplate, "createdAt">>,
): Omit<MediaCanvasTemplate, "id"> | null {
  if (typeof input !== "object" || input === null) return null;
  if (typeof input.name !== "string" || !input.name.trim()) return null;
  if (!Array.isArray(input.nodes) || input.nodes.length === 0) return null;
  const nodes = input.nodes.flatMap((node) => {
    if (!node || typeof node !== "object") return [];
    if (typeof node.title !== "string" || (node.kind !== "image" && node.kind !== "video")) return [];
    return [{
      title: node.title,
      kind: node.kind,
      defaultOperation: typeof node.defaultOperation === "string" ? node.defaultOperation : "textToImage",
      parameters: node.parameters && typeof node.parameters === "object" ? node.parameters as Record<string, unknown> : {},
      providerRef: node.providerRef && typeof node.providerRef === "object" ? node.providerRef : null,
    }];
  });
  if (nodes.length === 0) return null;
  const edges = Array.isArray(input.edges)
    ? input.edges.filter((edge) => edge
      && Number.isInteger(edge.sourceIndex) && Number.isInteger(edge.targetIndex)
      && edge.sourceIndex >= 0 && edge.sourceIndex < nodes.length
      && edge.targetIndex >= 0 && edge.targetIndex < nodes.length)
    : [];
  return {
    name: input.name.trim().slice(0, 120),
    createdAt: typeof input.createdAt === "string" ? input.createdAt : new Date().toISOString(),
    nodes,
    edges,
  };
}

export const useMediaTemplateStore = create<MediaTemplateState>()(
  persist(
    (set, get) => ({
      templates: [],
      saveTemplate: (template) => {
        const record: MediaCanvasTemplate = {
          ...template,
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
        };
        set({ templates: [record, ...get().templates].slice(0, MAX_TEMPLATES) });
        return record;
      },
      removeTemplate: (id) => set({ templates: get().templates.filter((template) => template.id !== id) }),
      importTemplates: (imported) => {
        const sanitized = imported
          .map(sanitizeTemplate)
          .filter((template): template is Omit<MediaCanvasTemplate, "id"> => template !== null)
          .map((template) => ({ ...template, id: crypto.randomUUID() }));
        if (sanitized.length > 0) {
          set({ templates: [...sanitized, ...get().templates].slice(0, MAX_TEMPLATES) });
        }
        return sanitized.length;
      },
    }),
    { name: "cc-panes-media-canvas-templates", version: 1 },
  ),
);
