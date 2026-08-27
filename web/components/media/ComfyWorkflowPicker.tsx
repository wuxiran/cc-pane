import { useEffect, useMemo, useRef, useState } from "react";
import { Check, FileJson, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useComfyWorkflowTemplateStore } from "@/stores";
import { getErrorMessage } from "@/utils";
import { parseComfyWorkflow } from "@/types/media";
import { normalizeComfyWorkflow } from "@/types/comfyWorkflowTemplate";

interface ComfyWorkflowPickerProps {
  providerId: string | null;
  value: string;
  onChange: (value: string) => void;
}

function latestWorkflow(template: { versions: Array<{ workflowJson: string }> }): string | null {
  return template.versions[template.versions.length - 1]?.workflowJson ?? null;
}

function fileBaseName(name: string): string {
  const withoutExtension = name.replace(/\.json$/i, "").trim();
  return withoutExtension || "ComfyUI workflow";
}

/**
 * The normal media path intentionally exposes only executable, saved
 * workflows. Raw API JSON and node controls remain available in the dedicated
 * advanced component, but are not part of the everyday generation form.
 */
export default function ComfyWorkflowPicker({ providerId, value, onChange }: ComfyWorkflowPickerProps) {
  const { t } = useTranslation("media");
  const allTemplates = useComfyWorkflowTemplateStore((state) => state.templates);
  const saveTemplate = useComfyWorkflowTemplateStore((state) => state.saveTemplate);
  const templates = useMemo(
    () => allTemplates
      .filter((template) => template.providerId === providerId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [allTemplates, providerId],
  );
  const [selectedId, setSelectedId] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Restore the last workflow for this provider when the form is reopened.
  // This makes an imported workflow behave like a normal preset on the next
  // visit without exposing its JSON representation.
  useEffect(() => {
    if (!providerId) {
      setSelectedId("");
      return;
    }
    const matching = templates.find((template) => latestWorkflow(template) === value);
    if (matching) {
      setSelectedId(matching.id);
      return;
    }
    if (!value.trim() && templates[0]) {
      const workflow = latestWorkflow(templates[0]);
      if (workflow) {
        setSelectedId(templates[0].id);
        onChange(workflow);
        return;
      }
    }
    if (!templates.some((template) => template.id === selectedId)) setSelectedId("");
  }, [onChange, providerId, selectedId, templates, value]);

  function chooseTemplate(templateId: string) {
    if (templateId === "__none__") {
      setSelectedId("");
      return;
    }
    const template = templates.find((candidate) => candidate.id === templateId);
    const workflow = template ? latestWorkflow(template) : null;
    if (!workflow) return;
    setSelectedId(templateId);
    onChange(workflow);
  }

  async function importWorkflow(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = parseComfyWorkflow(JSON.parse(await file.text()));
      if (!parsed.workflow) {
        toast.error(parsed.error === "ui_format" ? t("comfyUiWorkflowUnsupported") : t("comfyWorkflowInvalid"));
        return;
      }
      const normalized = normalizeComfyWorkflow(parsed.workflow).json;
      onChange(normalized);
      if (providerId) {
        try {
          const saved = saveTemplate(providerId, fileBaseName(file.name), normalized);
          setSelectedId(saved.id);
        } catch {
          // A valid workflow is still usable for this request even when its
          // filename cannot be persisted as a template.
          setSelectedId("");
        }
      }
      toast.success(t("comfyWorkflowImported"));
    } catch (error) {
      toast.error(getErrorMessage(error) || t("comfyWorkflowInvalid"));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const hasWorkflow = Boolean(value.trim());
  return (
    <div className="space-y-1.5" data-testid="comfy-ready-workflow-picker">
      <div className="flex min-w-0 items-center gap-1.5">
        <Select value={selectedId || "__none__"} onValueChange={chooseTemplate} disabled={!providerId || templates.length === 0}>
          <SelectTrigger size="sm" className="min-w-0 flex-1 text-[11px]" aria-label={t("comfyReadyWorkflow")}>
            <SelectValue placeholder={t("comfyReadyWorkflowPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">{templates.length > 0 ? t("comfyReadyWorkflowPlaceholder") : t("comfyNoTemplates")}</SelectItem>
            {templates.map((template) => (
              <SelectItem key={template.id} value={template.id}>{template.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <input ref={fileInputRef} type="file" accept=".json,application/json" className="sr-only" onChange={(event) => void importWorkflow(event)} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!providerId}
          aria-label={t("comfyChooseWorkflowFile")}
          title={t("comfyChooseWorkflowFile")}
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload aria-hidden="true" />
          <span className="hidden sm:inline">{t("comfyChooseWorkflowFile")}</span>
          <FileJson className="sm:hidden" aria-hidden="true" />
        </Button>
      </div>
      <div className="flex min-w-0 items-center gap-1 text-[10px]" style={{ color: hasWorkflow ? "var(--app-status-success)" : "var(--app-text-tertiary)" }}>
        {hasWorkflow ? <Check className="size-3 shrink-0" aria-hidden="true" /> : null}
        <span className="truncate">{hasWorkflow ? t("comfyWorkflowReady") : t("comfyWorkflowChooseHint")}</span>
      </div>
    </div>
  );
}
