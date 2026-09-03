import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderOpen, ImagePlus, Sparkles, Video } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SegmentedTabs } from "@/components/ui/segmented";
import MediaWorkspaceNavigator from "./MediaWorkspaceNavigator";
import MediaProviderSection from "./MediaProviderSection";
import MediaGenerationForm, { type MediaGenerationValues } from "./MediaGenerationForm";
import MediaCanvasView from "./MediaCanvasView";
import MediaHistoryPanel from "./MediaHistoryPanel";
import MediaPromptCopilot from "./MediaPromptCopilot";
import { mediaService } from "@/services/mediaService";
import { useMediaStore, useMediaStudioStore, useWorkspacesStore } from "@/stores";
import { legacyMediaLayoutId, useMediaCanvasStore } from "@/stores/useMediaCanvasStore";
import { getErrorMessage } from "@/utils";
import type { MediaStudioKind } from "@/stores/useMediaStudioStore";
import { MEDIA_NODE_SUBTYPE_PARAMETER, type MediaCanvasSpace, type MediaInputAssetSelection, type MediaNode, type MediaProviderCapabilities, type MediaProtocol, type MediaScope } from "@/types/media";

interface MediaStudioProps {
  kind: MediaStudioKind;
  onKindChange?: (kind: MediaStudioKind) => void;
}

function operationForLinkedInput(kind: "image" | "video", sourceKind: MediaInputAssetSelection["mediaKind"]) {
  if (kind === "image" && sourceKind === "image") return "imageToImage";
  if (kind === "video" && sourceKind === "image") return "imageToVideo";
  if (kind === "video" && sourceKind === "video") return "extend";
  return null;
}

export default function MediaStudio({ kind, onKindChange }: MediaStudioProps) {
  const { t } = useTranslation("media");
  const selection = useMediaStudioStore((state) => state.selections[kind]);
  const setSelection = useMediaStudioStore((state) => state.setSelection);
  const canvasSpaces = useMediaCanvasStore((state) => state.spaces);
  const activeCanvasSpaceIds = useMediaCanvasStore((state) => state.activeSpaceIds);
  const createCanvasSpace = useMediaCanvasStore((state) => state.createSpace);
  const ensureProjectCanvasSpace = useMediaCanvasStore((state) => state.ensureProjectSpace);
  const activateCanvasSpace = useMediaCanvasStore((state) => state.activateSpace);
  const selectedWorkspace = useWorkspacesStore((state) => state.workspaces.find((workspace) => workspace.id === selection.workspaceId));
  const projectedNodes = useMediaStore((state) => state.nodes);
  const [mediaNodes, setMediaNodes] = useState<MediaNode[]>([]);
  const [providerCapabilities, setProviderCapabilities] = useState<MediaProviderCapabilities | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [linkedInput, setLinkedInput] = useState<MediaInputAssetSelection | null>(null);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [promptOverride, setPromptOverride] = useState<{ value: string; token: number } | null>(null);
  const activeCanvasSpace = useMemo(() => {
    if (!selection.workspaceId) return null;
    const activeId = activeCanvasSpaceIds[selection.workspaceId];
    return canvasSpaces.find((space) => space.id === activeId) ?? null;
  }, [activeCanvasSpaceIds, canvasSpaces, selection.workspaceId]);
  const workspaceCanvasSpaces = useMemo(
    () => canvasSpaces.filter((space) => space.workspaceId === selection.workspaceId),
    [canvasSpaces, selection.workspaceId],
  );
  const layoutId = activeCanvasSpace?.layoutId ?? null;
  // Generation records stay keyed by the selected project. A workspace Canvas
  // queries all project graphs while a project Canvas uses this same legacy
  // key, so switching views never moves or duplicates a generated node.
  const generationLayoutId = useMemo(
    () => selection.workspaceId && selection.projectId
      ? legacyMediaLayoutId(selection.workspaceId, selection.projectId)
      : null,
    [selection.projectId, selection.workspaceId],
  );
  const selectedProject = useMemo(
    () => selectedWorkspace?.projects.find((project) => project.id === selection.projectId),
    [selectedWorkspace, selection.projectId],
  );
  const mediaScope = useMemo<MediaScope | null>(() => {
    if (!selection.workspaceId || !selection.projectId) return null;
    return {
      workspaceId: selection.workspaceId,
      projectId: selection.projectId,
      projectPath: selectedProject?.path ?? null,
    };
  }, [selectedProject?.path, selection.projectId, selection.workspaceId]);

  const nextCanvasName = useCallback((workspaceId: string) => (
    t("canvasSpaceName", {
      number: canvasSpaces.filter((space) => space.workspaceId === workspaceId).length + 1,
    })
  ), [canvasSpaces, t]);

  useEffect(() => {
    if (!selection.workspaceId || !selection.projectId) return;
    ensureProjectCanvasSpace({
      workspaceId: selection.workspaceId,
      projectId: selection.projectId,
      name: nextCanvasName(selection.workspaceId),
    });
  }, [ensureProjectCanvasSpace, nextCanvasName, selection.projectId, selection.workspaceId]);

  const loadNodes = useCallback(async () => {
    if (!selection.workspaceId || !generationLayoutId) {
      setMediaNodes([]);
      return;
    }
    try {
      setMediaNodes(await mediaService.listNodes(selection.workspaceId, generationLayoutId));
    } catch {
      setMediaNodes([]);
    }
  }, [generationLayoutId, selection.workspaceId]);

  useEffect(() => { void loadNodes(); }, [loadNodes, refreshToken]);

  useEffect(() => {
    setLinkedInput(null);
  }, [layoutId]);

  useEffect(() => {
    let cancelled = false;
    setProviderCapabilities(null);
    if (!selection.providerId) return () => { cancelled = true; };
    void mediaService
      .getProviderCapabilities(selection.providerId, selection.protocol ?? "sub2api")
      .then((capabilities) => {
        if (!cancelled) setProviderCapabilities(capabilities);
      })
      .catch(() => {
        if (!cancelled) setProviderCapabilities(null);
      });
    return () => { cancelled = true; };
  }, [selection.protocol, selection.providerId]);

  // Cmd/Ctrl+K opens the prompt copilot while the media studio is mounted.
  // Capture phase wins over the global command-palette shortcut, mirroring
  // how the studio owns its own context.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setCopilotOpen((current) => !current);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);

  const handleApplyPrompt = useCallback((text: string) => {
    setPromptOverride({ value: text, token: Date.now() });
  }, []);

  const handleSavePromptNode = useCallback(async (text: string) => {
    if (!selection.workspaceId || !generationLayoutId) {
      toast.error(t("selectWorkspaceProjectModel"));
      return;
    }
    try {
      await mediaService.createNode({
        workspaceId: selection.workspaceId,
        layoutId: generationLayoutId,
        kind: "image",
        title: text.slice(0, 48) || t("nodeTypeText"),
        defaultOperation: "textToImage",
        parameters: {
          [MEDIA_NODE_SUBTYPE_PARAMETER]: "text",
          contentText: text,
          ...(mediaScope ? { mediaScope } : {}),
        },
      });
      setRefreshToken((value) => value + 1);
      toast.success(t("copilotSavedNode"));
    } catch (error) {
      toast.error(t("nodeCreateFailed", { message: getErrorMessage(error) }));
    }
  }, [generationLayoutId, mediaScope, selection.workspaceId, t]);

  // 媒体 Provider 与工作空间的 LLM Provider 解耦（docs/99 B2）：切换工作空间
  // 只影响 scope，不再把工作空间的 CLI Provider 当媒体 Provider 默认值。
  const handleWorkspaceChange = useCallback((workspaceId: string) => {
    const workspace = useWorkspacesStore.getState().workspaces.find((item) => item.id === workspaceId);
    const projectId = workspace?.projects[0]?.id ?? null;
    setSelection(kind, { workspaceId, projectId });
  }, [kind, setSelection]);

  const handleProjectChange = useCallback((projectId: string) => setSelection(kind, { projectId }), [kind, setSelection]);

  const handleProviderChange = useCallback((providerId: string | null) => setSelection(kind, { providerId, modelId: null }), [kind, setSelection]);
  const handleModelChange = useCallback((modelId: string | null) => setSelection(kind, { modelId }), [kind, setSelection]);
  const handleProtocolChange = useCallback((protocol: MediaProtocol) => setSelection(kind, { protocol }), [kind, setSelection]);
  const handleKindChange = useCallback((nextKind: MediaStudioKind) => {
    onKindChange?.(nextKind);
  }, [onKindChange]);
  const handleCreateCanvas = useCallback((scope: { workspaceId: string; projectId: string | null }) => {
    const workspace = useWorkspacesStore.getState().workspaces.find((item) => item.id === scope.workspaceId);
    const projectId = scope.projectId
      ?? (scope.workspaceId === selection.workspaceId ? selection.projectId : null)
      ?? workspace?.projects[0]?.id
      ?? null;
    createCanvasSpace({
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      name: nextCanvasName(scope.workspaceId),
      layoutId: scope.projectId
        ? legacyMediaLayoutId(scope.workspaceId, scope.projectId)
        : undefined,
    });
    setSelection(kind, {
      workspaceId: scope.workspaceId,
      projectId,
    });
  }, [createCanvasSpace, kind, nextCanvasName, selection.projectId, selection.workspaceId, setSelection]);
  const handleCanvasChange = useCallback((space: MediaCanvasSpace) => {
    const workspace = useWorkspacesStore.getState().workspaces.find((item) => item.id === space.workspaceId);
    const projectId = space.projectId
      ?? (space.workspaceId === selection.workspaceId ? selection.projectId : null)
      ?? workspace?.projects[0]?.id
      ?? null;
    activateCanvasSpace(space.id);
    setSelection(kind, {
      workspaceId: space.workspaceId,
      projectId,
    });
  }, [activateCanvasSpace, kind, selection.projectId, selection.workspaceId, setSelection]);
  const handleUseOutput = useCallback((next: MediaInputAssetSelection) => {
    const operation = operationForLinkedInput(kind, next.mediaKind);
    if (!operation || (providerCapabilities && !providerCapabilities.operations.includes(operation))) {
      toast.error(t("linkedReferenceUnsupported"));
      return;
    }
    setLinkedInput(next);
  }, [kind, providerCapabilities, t]);

  async function handleGenerate(values: MediaGenerationValues) {
    if (!selection.workspaceId || !selection.projectId || !generationLayoutId || !selection.providerId || !selection.modelId || !mediaScope) {
      toast.error(t("selectWorkspaceProjectModel"));
      return;
    }
    // Keep the root scope in both the durable node snapshot and the run
    // envelope. The backend resolves the path by IDs and treats the path here
    // as display metadata only.
    const generationParameters = {
      ...values.parameters,
      providerProtocol: selection.protocol ?? "sub2api",
      mediaScope,
    };
    let inputAssetIds = [...new Set(values.inputAssetIds ?? [])];
    const inputFiles = values.inputFiles?.length
      ? values.inputFiles
      : values.inputFile
        ? [values.inputFile]
        : [];
    if (inputFiles.length > 0) {
      try {
        const assets = await Promise.all(inputFiles.map(async (inputFile) => {
          const encoded = inputFile.dataUrl.split(",", 2)[1] ?? "";
          return mediaService.stageInput({
            workspaceId: selection.workspaceId as string,
            filename: inputFile.name,
            mimeType: inputFile.mimeType,
            data: encoded,
            metadata: { role: inputFile.role ?? "reference", mediaScope },
            mediaScope,
          });
        }));
        inputAssetIds = [...inputAssetIds, ...assets.map((asset) => asset.id)];
      } catch (error) {
        toast.error(t("stageInputFailed", { message: getErrorMessage(error) }));
        return;
      }
    }
    try {
      const node = await mediaService.createNode({
        workspaceId: selection.workspaceId,
        layoutId: generationLayoutId,
        kind,
        title: values.prompt.slice(0, 48) || t(kind === "image" ? "imageGenerationTitle" : "videoGenerationTitle"),
        defaultOperation: values.operation,
        providerRef: { providerId: selection.providerId, modelId: selection.modelId },
        parameters: generationParameters,
        mediaScope,
      });
      await mediaService.createRun({
        nodeId: node.id,
        operation: values.operation,
        request: { prompt: values.prompt, parameters: generationParameters, mediaScope },
        clientRequestId: crypto.randomUUID(),
        inputAssetIds,
        priority: values.priority,
      });
      if (values.linkedInput) {
        try {
          await mediaService.createEdge({
            workspaceId: selection.workspaceId,
            layoutId: generationLayoutId,
            sourceNodeId: values.linkedInput.sourceNodeId,
            sourcePort: "output",
            targetNodeId: node.id,
            targetPort: "reference",
            selector: "specificAsset",
            assetId: values.linkedInput.assetId,
          });
        } catch (edgeError) {
          // The run already owns the selected asset, so an edge persistence
          // failure must not discard a valid generation request.
          toast.warning(t("mediaEdgeCreateFailed", { message: getErrorMessage(edgeError) }));
        }
      }
      toast.success(t(kind === "image" ? "jobSubmittedImage" : "jobSubmittedVideo"));
      setRefreshToken((value) => value + 1);
    } catch (error) {
      toast.error(t("submitJobFailed", { message: getErrorMessage(error) }));
    }
  }

  const title = t("mediaSpace");
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden" data-testid={`media-studio-${kind}`} data-media-workspace>
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-[var(--app-border)] px-4 py-1.5" style={{ background: "var(--app-menubar)" }}>
        <div className="flex min-w-0 items-center gap-2">
          {kind === "image" ? <ImagePlus className="size-4 shrink-0" style={{ color: "var(--app-accent)" }} aria-hidden="true" /> : <Video className="size-4 shrink-0" style={{ color: "var(--app-accent)" }} aria-hidden="true" />}
          <h1 className="truncate text-sm font-semibold" style={{ color: "var(--app-text-primary)" }}>{title}</h1>
          <span className="hidden truncate text-[10px] sm:inline" style={{ color: "var(--app-text-tertiary)" }}>{t("studioSubtitle")}</span>
        </div>
        <div className="min-w-0 flex-1" />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          title={t("copilotShortcutHint")}
          onClick={() => setCopilotOpen(true)}
          data-testid="media-copilot-open"
        >
          <Sparkles className="size-3.5" aria-hidden="true" />
          {t("promptCopilot")}
        </Button>
        <SegmentedTabs<MediaStudioKind>
          aria-label={t("mediaKind")}
          value={kind}
          onValueChange={handleKindChange}
          size="sm"
          items={[
            { value: "image", label: <span className="inline-flex items-center gap-1.5"><ImagePlus className="size-3.5" aria-hidden="true" />{t("imageMode")}</span> },
            { value: "video", label: <span className="inline-flex items-center gap-1.5"><Video className="size-3.5" aria-hidden="true" />{t("videoMode")}</span> },
          ]}
        />
      </header>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="app-scrollbar flex w-full shrink-0 flex-col overflow-y-auto border-b border-[var(--app-border)] lg:w-[360px] lg:border-b-0 lg:border-r" style={{ background: "var(--app-sidebar-bg)" }}>
          <MediaWorkspaceNavigator workspaceId={selection.workspaceId} projectId={selection.projectId} onWorkspaceChange={handleWorkspaceChange} onProjectChange={handleProjectChange} onCreateCanvas={handleCreateCanvas} />
          {mediaScope ? <div className="flex items-start gap-2 border-b border-[var(--app-border)] px-3 py-2" data-testid="media-generation-root">
            <FolderOpen className="mt-0.5 size-3.5 shrink-0" style={{ color: "var(--app-accent)" }} aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-[10px] font-medium" style={{ color: "var(--app-text-secondary)" }}>{t("generationRoot")}</p>
              <p className="truncate text-[10px]" title={mediaScope.projectPath ?? undefined} style={{ color: "var(--app-text-tertiary)" }}>{mediaScope.projectPath ?? t("projectPathUnavailable")}</p>
            </div>
          </div> : null}
          <MediaProviderSection providerId={selection.providerId} modelId={selection.modelId} protocol={selection.protocol ?? "sub2api"} capabilities={providerCapabilities} onProviderChange={handleProviderChange} onModelChange={handleModelChange} onProtocolChange={handleProtocolChange} />
          <MediaGenerationForm kind={kind} providerId={selection.providerId} modelId={selection.modelId} protocol={selection.protocol} capabilities={providerCapabilities} disabled={!selection.workspaceId || !selection.projectId || !layoutId} linkedInput={linkedInput} onClearLinkedInput={() => setLinkedInput(null)} onGenerate={handleGenerate} externalPrompt={promptOverride} />
          <MediaHistoryPanel nodes={mediaNodes} refreshToken={refreshToken + projectedNodes.length} targetKind={kind} onUseOutput={handleUseOutput} />
        </aside>
        <MediaCanvasView workspaceId={selection.workspaceId} layoutId={layoutId} activeSpace={activeCanvasSpace} spaces={workspaceCanvasSpaces} onSpaceChange={handleCanvasChange} refreshToken={refreshToken} />
      </div>
      <MediaPromptCopilot
        open={copilotOpen}
        onOpenChange={setCopilotOpen}
        onApplyPrompt={handleApplyPrompt}
        onSaveNode={handleSavePromptNode}
      />
    </div>
  );
}
