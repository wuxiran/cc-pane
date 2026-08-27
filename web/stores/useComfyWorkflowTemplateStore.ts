import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  COMFY_WORKFLOW_TEMPLATE_MAX_NAME_LENGTH,
  COMFY_WORKFLOW_TEMPLATE_MAX_VERSIONS,
  COMFY_WORKFLOW_TEMPLATE_STORE_VERSION,
  normalizeComfyWorkflow,
  type ComfyWorkflowTemplate,
  type ComfyWorkflowTemplateVersion,
} from "@/types/comfyWorkflowTemplate";

interface ComfyWorkflowTemplateState {
  templates: ComfyWorkflowTemplate[];
  saveTemplate: (
    providerId: string,
    name: string,
    workflow: string,
    schemaFingerprint?: string | null,
    templateId?: string,
  ) => ComfyWorkflowTemplate;
  deleteTemplate: (templateId: string) => void;
}

function id(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function cleanName(value: string): string {
  const name = value.trim();
  if (!name || name.length > COMFY_WORKFLOW_TEMPLATE_MAX_NAME_LENGTH || name.includes("\u0000")) {
    throw new Error("template name is invalid");
  }
  return name;
}

function versionFrom(
  workflowJson: string,
  version: number,
  schemaFingerprint?: string | null,
): ComfyWorkflowTemplateVersion {
  return {
    id: id("comfy-workflow-version"),
    version,
    workflowJson,
    schemaFingerprint: schemaFingerprint || null,
    savedAt: new Date().toISOString(),
  };
}

function sameVersion(a: ComfyWorkflowTemplateVersion | undefined, json: string, fingerprint?: string | null): boolean {
  return Boolean(a && a.workflowJson === json && (a.schemaFingerprint || null) === (fingerprint || null));
}

function lastVersion(versions: ComfyWorkflowTemplateVersion[]): ComfyWorkflowTemplateVersion | undefined {
  return versions[versions.length - 1];
}

function normalizePersistedTemplates(value: unknown): ComfyWorkflowTemplate[] {
  if (!Array.isArray(value)) return [];
  return value.filter((template): template is ComfyWorkflowTemplate => {
    if (!template || typeof template !== "object") return false;
    const candidate = template as Partial<ComfyWorkflowTemplate>;
    return typeof candidate.id === "string"
      && typeof candidate.providerId === "string"
      && typeof candidate.name === "string"
      && Array.isArray(candidate.versions)
      && candidate.versions.length > 0;
  }).map((template) => ({
    ...template,
    versions: (template.versions as ComfyWorkflowTemplateVersion[]).filter((version) => (
      typeof version?.id === "string"
      && Number.isInteger(version.version)
      && typeof version.workflowJson === "string"
      && typeof version.savedAt === "string"
    )).slice(-COMFY_WORKFLOW_TEMPLATE_MAX_VERSIONS),
  })).filter((template) => template.versions.length > 0);
}

export const useComfyWorkflowTemplateStore = create<ComfyWorkflowTemplateState>()(
  persist(
    (set) => ({
      templates: [],
      saveTemplate: (providerId, rawName, rawWorkflow, schemaFingerprint, templateId) => {
        const normalizedProviderId = providerId.trim();
        if (!normalizedProviderId) throw new Error("provider is required");
        const name = cleanName(rawName);
        const normalized = normalizeComfyWorkflow(rawWorkflow);
        let saved: ComfyWorkflowTemplate | undefined;
        set((state) => {
          const now = new Date().toISOString();
          const existingIndex = templateId
            ? state.templates.findIndex((template) => template.id === templateId && template.providerId === normalizedProviderId)
            : -1;
          if (existingIndex >= 0) {
            const existing = state.templates[existingIndex];
            if (sameVersion(lastVersion(existing.versions), normalized.json, schemaFingerprint)) {
              saved = existing;
              return state;
            }
            const nextVersion = versionFrom(normalized.json, (lastVersion(existing.versions)?.version ?? 0) + 1, schemaFingerprint);
            saved = {
              ...existing,
              name,
              updatedAt: now,
              versions: [...existing.versions, nextVersion].slice(-COMFY_WORKFLOW_TEMPLATE_MAX_VERSIONS),
            };
            const templates = [...state.templates];
            templates[existingIndex] = saved;
            return { templates };
          }
          const firstVersion = versionFrom(normalized.json, 1, schemaFingerprint);
          saved = {
            id: id("comfy-workflow-template"),
            providerId: normalizedProviderId,
            name,
            createdAt: now,
            updatedAt: now,
            versions: [firstVersion],
          };
          return { templates: [saved, ...state.templates] };
        });
        if (!saved) throw new Error("template was not saved");
        return saved;
      },
      deleteTemplate: (templateId) => set((state) => ({
        templates: state.templates.filter((template) => template.id !== templateId),
      })),
    }),
    {
      name: "cc-panes-comfy-workflow-templates",
      version: COMFY_WORKFLOW_TEMPLATE_STORE_VERSION,
      migrate: (persisted) => {
        const state = persisted as Partial<ComfyWorkflowTemplateState> | undefined;
        return { templates: normalizePersistedTemplates(state?.templates) };
      },
      partialize: (state) => ({ templates: state.templates }),
    },
  ),
);
