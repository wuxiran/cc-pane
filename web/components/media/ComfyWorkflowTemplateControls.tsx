import { useMemo, useState } from "react";
import { FolderOpen, GitCompareArrows, History, Save, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useComfyWorkflowTemplateStore } from "@/stores";
import { getErrorMessage } from "@/utils";
import { diffComfyWorkflows, normalizeComfyWorkflow, type ComfyWorkflowTemplate, type ComfyWorkflowTemplateVersion } from "@/types/comfyWorkflowTemplate";

interface ComfyWorkflowTemplateControlsProps {
  providerId: string | null;
  value: string;
  schemaFingerprint?: string | null;
  onChange: (value: string) => void;
}

function latestVersion(template: ComfyWorkflowTemplate | undefined): ComfyWorkflowTemplateVersion | undefined {
  return template?.versions[template.versions.length - 1];
}

function formatSavedAt(value: string, language: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "short" }).format(date);
}

export default function ComfyWorkflowTemplateControls({
  providerId,
  value,
  schemaFingerprint,
  onChange,
}: ComfyWorkflowTemplateControlsProps) {
  const { t, i18n } = useTranslation("media");
  const allTemplates = useComfyWorkflowTemplateStore((state) => state.templates);
  const saveTemplate = useComfyWorkflowTemplateStore((state) => state.saveTemplate);
  const deleteTemplate = useComfyWorkflowTemplateStore((state) => state.deleteTemplate);
  const templates = useMemo(
    () => allTemplates.filter((template) => template.providerId === providerId),
    [allTemplates, providerId],
  );
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [saveOpen, setSaveOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [compareVersionId, setCompareVersionId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId);
  const currentWorkflow = useMemo(() => {
    try {
      return normalizeComfyWorkflow(value);
    } catch {
      return null;
    }
  }, [value]);
  const compareVersion = selectedTemplate?.versions.find((version) => version.id === compareVersionId);
  const compareIndex = compareVersion
    ? selectedTemplate?.versions.findIndex((version) => version.id === compareVersion.id) ?? -1
    : -1;
  const previousVersion = compareIndex > 0 ? selectedTemplate?.versions[compareIndex - 1] : undefined;
  const comparison = useMemo(() => {
    if (!compareVersion) return null;
    try {
      const target = normalizeComfyWorkflow(compareVersion.workflowJson);
      if (previousVersion) {
        const base = normalizeComfyWorkflow(previousVersion.workflowJson);
        return {
          label: t("comfyTemplateVersionPair", { from: previousVersion.version, to: compareVersion.version }),
          diff: diffComfyWorkflows(base.workflow, target.workflow, previousVersion.schemaFingerprint, compareVersion.schemaFingerprint),
          before: base.json,
          after: target.json,
        };
      }
      if (currentWorkflow) {
        return {
          label: t("comfyTemplateCurrentComparison", { version: compareVersion.version }),
          diff: diffComfyWorkflows(target.workflow, currentWorkflow.workflow, compareVersion.schemaFingerprint, schemaFingerprint),
          before: target.json,
          after: currentWorkflow.json,
        };
      }
    } catch {
      return null;
    }
    return null;
  }, [compareVersion, currentWorkflow, previousVersion, schemaFingerprint, t]);

  function chooseTemplate(templateId: string) {
    setSelectedTemplateId(templateId === "__none__" ? "" : templateId);
    setError(null);
  }

  function loadLatest() {
    const version = latestVersion(selectedTemplate);
    if (!version) return;
    onChange(version.workflowJson);
    setError(null);
  }

  function openSaveDialog() {
    setTemplateName(selectedTemplate?.name ?? "");
    setError(null);
    setSaveOpen(true);
  }

  function save() {
    if (!providerId) return;
    try {
      const template = saveTemplate(providerId, templateName, value, schemaFingerprint, selectedTemplate?.id);
      setSelectedTemplateId(template.id);
      setSaveOpen(false);
      setError(null);
    } catch (saveError) {
      setError(getErrorMessage(saveError));
    }
  }

  function openHistory() {
    if (!selectedTemplate && templates[0]) setSelectedTemplateId(templates[0].id);
    const template = selectedTemplate ?? templates[0];
    setCompareVersionId(latestVersion(template)?.id ?? "");
    setHistoryOpen(true);
  }

  function loadVersion(version: ComfyWorkflowTemplateVersion) {
    onChange(version.workflowJson);
    setHistoryOpen(false);
    setError(null);
  }

  function removeSelected() {
    if (!selectedTemplate) return;
    deleteTemplate(selectedTemplate.id);
    setSelectedTemplateId("");
    setCompareVersionId("");
  }

  return (
    <>
      <div className="flex min-w-0 items-center gap-1" data-testid="comfy-workflow-template-controls">
        <Select value={selectedTemplateId || "__none__"} onValueChange={chooseTemplate} disabled={!providerId}>
          <SelectTrigger size="sm" className="min-w-0 flex-1 text-[10px]" aria-label={t("comfyTemplateSelect")}>
            <SelectValue placeholder={t("comfyTemplates")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">{t("comfyTemplateSelect")}</SelectItem>
            {templates.map((template) => (
              <SelectItem key={template.id} value={template.id}>
                {template.name} · v{latestVersion(template)?.version ?? 0}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="button" variant="ghost" size="icon-xs" disabled={!selectedTemplate} onClick={loadLatest} aria-label={t("comfyLoadTemplate")} title={t("comfyLoadTemplate")}>
          <FolderOpen aria-hidden="true" />
        </Button>
        <Button type="button" variant="ghost" size="icon-xs" disabled={!providerId} onClick={openSaveDialog} aria-label={t("comfySaveTemplate")} title={t("comfySaveTemplate")}>
          <Save aria-hidden="true" />
        </Button>
        <Button type="button" variant="ghost" size="icon-xs" disabled={templates.length === 0} onClick={openHistory} aria-label={t("comfyTemplateHistory")} title={t("comfyTemplateHistory")}>
          <History aria-hidden="true" />
        </Button>
      </div>
      {error ? <p className="text-[10px]" style={{ color: "var(--app-status-danger)" }}>{t("comfyTemplateSaveFailed", { message: error })}</p> : null}

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{t("comfySaveTemplate")}</DialogTitle></DialogHeader>
          <div className="space-y-1.5">
            <label htmlFor="comfy-template-name" className="text-[11px]" style={{ color: "var(--app-text-secondary)" }}>{t("comfyTemplateName")}</label>
            <Input id="comfy-template-name" value={templateName} onChange={(event) => setTemplateName(event.target.value)} placeholder={t("comfyTemplateNamePlaceholder")} autoFocus />
            <p className="text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>{selectedTemplate ? t("comfyTemplateNewVersion", { name: selectedTemplate.name }) : t("comfyTemplateNew")}</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setSaveOpen(false)}>{t("cancel")}</Button>
            <Button type="button" disabled={!templateName.trim() || !currentWorkflow} onClick={save}><Save aria-hidden="true" />{t("save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-h-[82vh] sm:max-w-2xl">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><History aria-hidden="true" />{selectedTemplate?.name || t("comfyTemplateHistory")}</DialogTitle></DialogHeader>
          {selectedTemplate ? <div className="min-h-0 space-y-2 overflow-y-auto">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>{t("comfyTemplateVersionCount", { count: selectedTemplate.versions.length })}</span>
              <Button type="button" variant="ghost" size="icon-xs" onClick={removeSelected} aria-label={t("comfyDeleteTemplate")} title={t("comfyDeleteTemplate")}><Trash2 aria-hidden="true" /></Button>
            </div>
            <div className="space-y-1">
              {[...selectedTemplate.versions].reverse().map((version) => (
                <div key={version.id} className="flex items-center gap-2 border-b border-[var(--app-border)] py-1.5 last:border-b-0">
                  <span className="min-w-0 flex-1 text-[10px]" style={{ color: "var(--app-text-secondary)" }}>{t("comfyTemplateVersion", { version: version.version })} · {formatSavedAt(version.savedAt, i18n.language)}</span>
                  <Button type="button" variant="ghost" size="icon-xs" onClick={() => setCompareVersionId(version.id)} aria-label={t("comfyTemplateCompare")} title={t("comfyTemplateCompare")}><GitCompareArrows aria-hidden="true" /></Button>
                  <Button type="button" variant="ghost" size="icon-xs" onClick={() => loadVersion(version)} aria-label={t("comfyLoadTemplateVersion")} title={t("comfyLoadTemplateVersion")}><FolderOpen aria-hidden="true" /></Button>
                </div>
              ))}
            </div>
            {comparison ? <div className="space-y-1.5 border-t border-[var(--app-border)] pt-2">
              <p className="text-[10px] font-medium" style={{ color: "var(--app-text-primary)" }}>{comparison.label}</p>
              <div className="flex flex-wrap gap-1 text-[9px]" style={{ color: "var(--app-text-tertiary)" }}>
                <span>{t("comfyTemplateAddedNodes", { count: comparison.diff.addedNodeIds.length })}</span>
                <span>{t("comfyTemplateRemovedNodes", { count: comparison.diff.removedNodeIds.length })}</span>
                <span>{t("comfyTemplateChangedNodes", { count: comparison.diff.changedNodeIds.length })}</span>
                {comparison.diff.schemaChanged ? <span style={{ color: "var(--app-status-warning)" }}>{t("comfyTemplateSchemaChanged")}</span> : null}
                {comparison.diff.addedNodeIds.length === 0 && comparison.diff.removedNodeIds.length === 0 && comparison.diff.changedNodeIds.length === 0 && !comparison.diff.schemaChanged ? <span>{t("comfyTemplateNoChanges")}</span> : null}
              </div>
              <div className="grid min-h-0 gap-1 md:grid-cols-2">
                <pre className="max-h-48 overflow-auto rounded border border-[var(--app-border)] p-2 text-[9px] leading-relaxed" aria-label={t("comfyTemplateBefore")}>{comparison.before}</pre>
                <pre className="max-h-48 overflow-auto rounded border border-[var(--app-border)] p-2 text-[9px] leading-relaxed" aria-label={t("comfyTemplateAfter")}>{comparison.after}</pre>
              </div>
            </div> : null}
          </div> : <p className="text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("comfyNoTemplates")}</p>}
        </DialogContent>
      </Dialog>
    </>
  );
}
