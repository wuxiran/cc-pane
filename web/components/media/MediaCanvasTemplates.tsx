import { useRef, useState } from "react";
import { Download, LayoutTemplate, Play, Trash2, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { mediaService } from "@/services/mediaService";
import { useMediaTemplateStore, type MediaCanvasTemplate, type MediaCanvasTemplateEdge } from "@/stores/useMediaTemplateStore";
import { MEDIA_SCOPE_PARAMETER } from "@/types/media";
import { getErrorMessage } from "@/utils";

interface MediaCanvasTemplatesProps {
  workspaceId: string | null;
  /** Graph key new nodes are written to. */
  layoutId: string | null;
  /** Graph key the current canvas reads from (null = whole workspace). */
  queryLayoutId: string | null;
  onApplied: () => void;
}

/**
 * Canvas-level workflow templates: capture the current graph's node
 * parameters and edges, replay them onto any canvas, and exchange them as
 * JSON files. Assets and run history are intentionally not captured.
 */
export default function MediaCanvasTemplates({ workspaceId, layoutId, queryLayoutId, onApplied }: MediaCanvasTemplatesProps) {
  const { t } = useTranslation("media");
  const templates = useMediaTemplateStore((state) => state.templates);
  const saveTemplate = useMediaTemplateStore((state) => state.saveTemplate);
  const removeTemplate = useMediaTemplateStore((state) => state.removeTemplate);
  const importTemplates = useMediaTemplateStore((state) => state.importTemplates);
  const [open, setOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const captureCurrentCanvas = async () => {
    if (!workspaceId || !templateName.trim()) return;
    setBusy(true);
    try {
      const [nodes, edges] = await Promise.all([
        mediaService.listNodes(workspaceId, queryLayoutId ?? undefined),
        mediaService.listEdges(workspaceId, queryLayoutId ?? undefined).catch(() => []),
      ]);
      if (nodes.length === 0) {
        toast.error(t("templateCanvasEmpty"));
        return;
      }
      const indexById = new Map(nodes.map((node, index) => [node.id, index]));
      const templateEdges: MediaCanvasTemplateEdge[] = edges.flatMap((edge) => {
        const sourceIndex = indexById.get(edge.sourceNodeId);
        const targetIndex = indexById.get(edge.targetNodeId);
        if (sourceIndex === undefined || targetIndex === undefined) return [];
        return [{ sourceIndex, targetIndex, sourcePort: edge.sourcePort, targetPort: edge.targetPort }];
      });
      saveTemplate({
        name: templateName.trim(),
        nodes: nodes.map((node) => {
          // The scope is bound to the source project; strip it so the
          // template can be replayed anywhere.
          const { [MEDIA_SCOPE_PARAMETER]: _scope, ...parameters } = node.parameters;
          return {
            title: node.title,
            kind: node.kind,
            defaultOperation: node.defaultOperation,
            parameters,
            providerRef: node.providerRef ?? null,
          };
        }),
        edges: templateEdges,
      });
      setTemplateName("");
      toast.success(t("templateSaved"));
    } catch (error) {
      toast.error(t("templateSaveFailed", { message: getErrorMessage(error) }));
    } finally {
      setBusy(false);
    }
  };

  const applyTemplate = async (template: MediaCanvasTemplate) => {
    if (!workspaceId || !layoutId) return;
    setBusy(true);
    try {
      const createdIds: string[] = [];
      for (const node of template.nodes) {
        const created = await mediaService.createNode({
          workspaceId,
          layoutId,
          kind: node.kind,
          title: node.title,
          defaultOperation: node.defaultOperation,
          providerRef: node.providerRef ?? undefined,
          parameters: node.parameters,
        });
        createdIds.push(created.id);
      }
      for (const edge of template.edges) {
        const sourceNodeId = createdIds[edge.sourceIndex];
        const targetNodeId = createdIds[edge.targetIndex];
        if (!sourceNodeId || !targetNodeId) continue;
        await mediaService.createEdge({
          workspaceId,
          layoutId,
          sourceNodeId,
          sourcePort: edge.sourcePort,
          targetNodeId,
          targetPort: edge.targetPort,
          selector: "latestSucceeded",
        }).catch(() => undefined);
      }
      toast.success(t("templateApplied", { count: template.nodes.length }));
      setOpen(false);
      onApplied();
    } catch (error) {
      toast.error(t("templateApplyFailed", { message: getErrorMessage(error) }));
    } finally {
      setBusy(false);
    }
  };

  const exportTemplate = (template: MediaCanvasTemplate) => {
    const blob = new Blob([JSON.stringify([template], null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${template.name.replace(/[^\w\u4e00-\u9fff-]+/g, "_") || "template"}.ccpanes-media-template.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importFromFile = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const count = importTemplates(list as Parameters<typeof importTemplates>[0]);
      if (count > 0) toast.success(t("templateImported", { count }));
      else toast.error(t("templateImportInvalid"));
    } catch (error) {
      toast.error(t("templateImportFailed", { message: getErrorMessage(error) }));
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2 text-[11px]"
        disabled={!workspaceId}
        onClick={() => setOpen(true)}
        data-testid="media-canvas-templates"
      >
        <LayoutTemplate className="size-3.5" aria-hidden="true" />
        {t("templatesButton")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg" data-testid="media-canvas-templates-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <LayoutTemplate className="size-4" style={{ color: "var(--app-accent)" }} aria-hidden="true" />
              {t("templatesTitle")}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Input
                className="h-7 flex-1 text-xs"
                value={templateName}
                placeholder={t("templateNamePlaceholder")}
                onChange={(event) => setTemplateName(event.target.value)}
              />
              <Button
                type="button"
                size="sm"
                className="h-7 text-xs"
                disabled={busy || !templateName.trim() || !workspaceId}
                onClick={() => void captureCurrentCanvas()}
                data-testid="template-save-current"
              >
                {t("templateSaveCurrent")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1 text-xs"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="size-3" aria-hidden="true" />
                {t("templateImport")}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void importFromFile(file);
                  event.target.value = "";
                }}
              />
            </div>
            <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
              {templates.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("templatesEmpty")}</p>
              ) : templates.map((template) => (
                <div
                  key={template.id}
                  className="flex items-center gap-2 rounded border px-2 py-1.5"
                  style={{ borderColor: "var(--app-border)" }}
                  data-testid={`media-template-${template.id}`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium" style={{ color: "var(--app-text-primary)" }}>{template.name}</p>
                    <p className="text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>
                      {t("templateSummary", { nodes: template.nodes.length, edges: template.edges.length })}
                    </p>
                  </div>
                  <Button type="button" variant="outline" size="sm" className="h-6 gap-1 px-2 text-[10px]" disabled={busy || !workspaceId || !layoutId} onClick={() => void applyTemplate(template)}>
                    <Play className="size-3" aria-hidden="true" />{t("templateApply")}
                  </Button>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={t("templateExport")} title={t("templateExport")} onClick={() => exportTemplate(template)}>
                    <Download aria-hidden="true" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={t("templateDelete")} title={t("templateDelete")} onClick={() => removeTemplate(template.id)}>
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
