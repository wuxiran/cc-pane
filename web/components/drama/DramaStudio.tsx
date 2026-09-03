import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clapperboard } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import BatchRestyleDialog from "./BatchRestyleDialog";
import DramaEpisodeEditor from "./DramaEpisodeEditor";
import DramaSidebar from "./DramaSidebar";
import { SPLIT_SYSTEM_PROMPT, parseShotsReply } from "./dramaSplit";
import { completePrompt, supportsPromptCompletion } from "@/services/promptCopilotService";
import { dramaService } from "@/services/dramaService";
import { mediaService } from "@/services/mediaService";
import { useMediaStudioStore, useProvidersStore, useWorkspacesStore } from "@/stores";
import { legacyMediaLayoutId } from "@/stores/useMediaCanvasStore";
import { getErrorMessage } from "@/utils";
import type { DramaEpisode, DramaProject, DramaShot } from "@/types/drama";
import type { MediaRun, MediaScope } from "@/types/media";

/**
 * Short-drama production studio: project → episode → screenplay → shots →
 * per-shot image / video generation. Generation reuses the media pipeline
 * (createNode + createRun on the project's media canvas), so results also
 * appear as regular canvas nodes.
 */
export default function DramaStudio() {
  const { t } = useTranslation("media");
  const imageSelection = useMediaStudioStore((state) => state.selections.image);
  const videoSelection = useMediaStudioStore((state) => state.selections.video);
  const providers = useProvidersStore((state) => state.providers);
  const eligibleLlmProviders = useMemo(() => providers.filter(supportsPromptCompletion), [providers]);
  const workspaceId = imageSelection.workspaceId;
  const projectId = imageSelection.projectId;
  const selectedWorkspace = useWorkspacesStore((state) => state.workspaces.find((workspace) => workspace.id === workspaceId));
  const selectedProject = selectedWorkspace?.projects.find((project) => project.id === projectId);
  const layoutId = workspaceId && projectId ? legacyMediaLayoutId(workspaceId, projectId) : null;
  const mediaScope = useMemo<MediaScope | null>(
    () => workspaceId && projectId
      ? { workspaceId, projectId, projectPath: selectedProject?.path ?? null }
      : null,
    [projectId, selectedProject?.path, workspaceId],
  );

  const [projects, setProjects] = useState<DramaProject[]>([]);
  const [selectedDramaId, setSelectedDramaId] = useState<string | null>(null);
  const [episodes, setEpisodes] = useState<DramaEpisode[]>([]);
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string | null>(null);
  const [shots, setShots] = useState<DramaShot[]>([]);
  const [screenplayDraft, setScreenplayDraft] = useState("");
  const [runStates, setRunStates] = useState<Record<string, MediaRun>>({});
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [selectedShotIds, setSelectedShotIds] = useState<Record<string, true>>({});
  const [splitProviderId, setSplitProviderId] = useState<string | null>(null);
  const [splitting, setSplitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [restyleOpen, setRestyleOpen] = useState(false);
  const previewRequests = useRef(new Set<string>());

  const selectedEpisode = episodes.find((episode) => episode.id === selectedEpisodeId) ?? null;
  const splitProvider = eligibleLlmProviders.find((candidate) => candidate.id === splitProviderId)
    ?? eligibleLlmProviders[0]
    ?? null;

  const loadProjects = useCallback(async () => {
    if (!workspaceId) {
      setProjects([]);
      return;
    }
    try {
      const loaded = await dramaService.listProjects(workspaceId);
      setProjects(loaded);
      setSelectedDramaId((current) => current && loaded.some((project) => project.id === current) ? current : loaded[0]?.id ?? null);
    } catch (error) {
      toast.error(t("dramaLoadFailed", { message: getErrorMessage(error) }));
    }
  }, [t, workspaceId]);

  const loadEpisodes = useCallback(async () => {
    if (!selectedDramaId) {
      setEpisodes([]);
      setSelectedEpisodeId(null);
      return;
    }
    try {
      const loaded = await dramaService.listEpisodes(selectedDramaId);
      setEpisodes(loaded);
      setSelectedEpisodeId((current) => current && loaded.some((episode) => episode.id === current) ? current : loaded[0]?.id ?? null);
    } catch (error) {
      toast.error(t("dramaLoadFailed", { message: getErrorMessage(error) }));
    }
  }, [selectedDramaId, t]);

  const loadShots = useCallback(async () => {
    if (!selectedEpisodeId) {
      setShots([]);
      return;
    }
    try {
      setShots(await dramaService.listShots(selectedEpisodeId));
    } catch (error) {
      toast.error(t("dramaLoadFailed", { message: getErrorMessage(error) }));
    }
  }, [selectedEpisodeId, t]);

  useEffect(() => { void loadProjects(); }, [loadProjects]);
  useEffect(() => { void loadEpisodes(); }, [loadEpisodes]);
  useEffect(() => { void loadShots(); }, [loadShots]);
  useEffect(() => {
    setScreenplayDraft(selectedEpisode?.screenplay ?? "");
  }, [selectedEpisode?.id, selectedEpisode?.screenplay]);
  useEffect(() => { setSelectedShotIds({}); }, [selectedEpisodeId]);

  // Poll generation state for every referenced run; resolve image previews
  // once a run succeeds. 5s cadence matches the media canvas poll.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const runIds = [...new Set(shots.flatMap((shot) => [shot.imageRunId, shot.videoRunId].filter((id): id is string => Boolean(id))))];
      const pending = runIds.filter((id) => runStates[id]?.status !== "succeeded"
        && runStates[id]?.status !== "failed"
        && runStates[id]?.status !== "canceled");
      const refreshed = await Promise.all(pending.map(async (runId) => {
        try {
          return await mediaService.getRun(runId);
        } catch {
          return null;
        }
      }));
      if (cancelled) return;
      const patch: Record<string, MediaRun> = {};
      for (const run of refreshed) if (run) patch[run.id] = run;
      if (Object.keys(patch).length > 0) setRunStates((current) => ({ ...current, ...patch }));
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // runStates is read for filtering only; re-subscribing on every state
    // patch would reset the interval each poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shots]);

  // Resolve previews for succeeded runs (both image thumbnails and videos).
  useEffect(() => {
    if (!workspaceId) return;
    for (const run of Object.values(runStates)) {
      if (run.status !== "succeeded" || previews[run.id] || previewRequests.current.has(run.id)) continue;
      const assetId = run.outputAssetIds[0];
      if (!assetId) continue;
      previewRequests.current.add(run.id);
      void mediaService.resolveAssetUrl(assetId)
        .then((url) => setPreviews((current) => ({ ...current, [run.id]: url })))
        .catch(() => previewRequests.current.delete(run.id));
    }
  }, [previews, runStates, workspaceId]);

  const requireMediaSelection = (selection: { providerId: string | null; modelId: string | null }): boolean => {
    if (!workspaceId || !projectId || !layoutId || !mediaScope || !selection.providerId || !selection.modelId) {
      toast.error(t("dramaNeedMediaSelection"));
      return false;
    }
    return true;
  };

  const runStatusLabel = (runId: string | null | undefined): string => {
    if (!runId) return t("notRun");
    const status = runStates[runId]?.status;
    if (!status) return t("queued");
    const keyByStatus = {
      queued: "queued",
      submitting: "submittingStatus",
      processing: "processing",
      downloading: "downloading",
      canceling: "canceling",
      succeeded: "succeeded",
      failed: "failed",
      canceled: "canceled",
    } as const;
    const key = keyByStatus[status];
    return key ? t(key) : status;
  };

  const patchShotInState = (updated: DramaShot) => {
    setShots((current) => current.map((shot) => shot.id === updated.id ? updated : shot));
  };

  async function generateShotImage(shot: DramaShot) {
    if (!requireMediaSelection(imageSelection)) return;
    const prompt = shot.prompt.trim();
    if (!prompt) {
      toast.error(t("dramaShotPromptMissing"));
      return;
    }
    const parameters = {
      providerProtocol: imageSelection.protocol ?? "open_ai_compatible",
      mediaScope,
      dramaShotId: shot.id,
    };
    const node = await mediaService.createNode({
      workspaceId: workspaceId as string,
      layoutId: layoutId as string,
      kind: "image",
      title: shot.title || prompt.slice(0, 48),
      defaultOperation: "textToImage",
      providerRef: { providerId: imageSelection.providerId as string, modelId: imageSelection.modelId as string },
      parameters,
      mediaScope: mediaScope as MediaScope,
    });
    const run = await mediaService.createRun({
      nodeId: node.id,
      operation: "textToImage",
      request: { prompt, parameters, mediaScope },
      clientRequestId: crypto.randomUUID(),
    });
    patchShotInState(await dramaService.updateShot(shot.id, { imageNodeId: node.id, imageRunId: run.id }));
  }

  async function generateShotVideo(shot: DramaShot) {
    if (!requireMediaSelection(videoSelection)) return;
    const imageRun = shot.imageRunId ? runStates[shot.imageRunId] : undefined;
    const inputAssetId = imageRun?.status === "succeeded" ? imageRun.outputAssetIds[0] : undefined;
    if (!inputAssetId) {
      toast.error(t("dramaShotImageMissing"));
      return;
    }
    const prompt = shot.prompt.trim() || shot.title;
    const parameters = {
      providerProtocol: videoSelection.protocol ?? "open_ai_compatible",
      mediaScope,
      dramaShotId: shot.id,
    };
    const node = await mediaService.createNode({
      workspaceId: workspaceId as string,
      layoutId: layoutId as string,
      kind: "video",
      title: shot.title || prompt.slice(0, 48),
      defaultOperation: "imageToVideo",
      providerRef: { providerId: videoSelection.providerId as string, modelId: videoSelection.modelId as string },
      parameters,
      mediaScope: mediaScope as MediaScope,
    });
    const run = await mediaService.createRun({
      nodeId: node.id,
      operation: "imageToVideo",
      request: { prompt, parameters, mediaScope },
      clientRequestId: crypto.randomUUID(),
      inputAssetIds: [inputAssetId],
    });
    patchShotInState(await dramaService.updateShot(shot.id, { videoNodeId: node.id, videoRunId: run.id }));
  }

  async function runBatch(targets: DramaShot[], operation: (shot: DramaShot) => Promise<void>) {
    setGenerating(true);
    try {
      for (const shot of targets) {
        try {
          await operation(shot);
        } catch (error) {
          toast.error(t("dramaGenerateFailed", { title: shot.title || `#${shot.ordinal + 1}`, message: getErrorMessage(error) }));
        }
      }
    } finally {
      setGenerating(false);
    }
  }

  const selectedShots = shots.filter((shot) => selectedShotIds[shot.id]);
  const batchTargets = selectedShots.length > 0 ? selectedShots : shots;
  const restyleEligible = batchTargets.filter((shot) => {
    const run = shot.imageRunId ? runStates[shot.imageRunId] : undefined;
    return run?.status === "succeeded" && run.outputAssetIds.length > 0;
  });

  async function restyleBatch(stylePrompt: string) {
    if (!requireMediaSelection(imageSelection)) return;
    await runBatch(restyleEligible, async (shot) => {
      const imageRun = runStates[shot.imageRunId as string];
      const inputAssetId = imageRun.outputAssetIds[0];
      const prompt = [stylePrompt, shot.prompt.trim()].filter(Boolean).join("\n");
      const parameters = {
        providerProtocol: imageSelection.protocol ?? "open_ai_compatible",
        mediaScope,
        dramaShotId: shot.id,
        restyleOfNodeId: shot.imageNodeId,
      };
      const node = await mediaService.createNode({
        workspaceId: workspaceId as string,
        layoutId: layoutId as string,
        kind: "image",
        title: `${shot.title || t("dramaShot")} · ${t("restyleTitle")}`,
        defaultOperation: "imageToImage",
        providerRef: { providerId: imageSelection.providerId as string, modelId: imageSelection.modelId as string },
        parameters,
        mediaScope: mediaScope as MediaScope,
      });
      const run = await mediaService.createRun({
        nodeId: node.id,
        operation: "imageToImage",
        request: { prompt, parameters, mediaScope },
        clientRequestId: crypto.randomUUID(),
        inputAssetIds: [inputAssetId],
      });
      patchShotInState(await dramaService.updateShot(shot.id, { imageNodeId: node.id, imageRunId: run.id }));
    });
  }

  async function splitScreenplay() {
    if (!selectedEpisodeId || !screenplayDraft.trim()) return;
    if (!splitProvider) {
      toast.error(t("copilotNoProviders"));
      return;
    }
    const modelId = splitProvider.defaultModelId ?? splitProvider.models?.[0]?.id;
    if (!modelId) {
      toast.error(t("dramaSplitNoModel"));
      return;
    }
    setSplitting(true);
    try {
      const reply = await completePrompt({
        provider: splitProvider,
        modelId,
        system: SPLIT_SYSTEM_PROMPT,
        prompt: screenplayDraft.trim(),
        maxTokens: 4096,
      });
      const parsedShots = parseShotsReply(reply);
      if (parsedShots.length === 0) throw new Error(t("dramaSplitEmpty"));
      for (const parsed of parsedShots) {
        await dramaService.createShot({
          episodeId: selectedEpisodeId,
          title: parsed.title,
          dialogue: parsed.dialogue,
          prompt: parsed.prompt,
        });
      }
      await loadShots();
      toast.success(t("dramaSplitDone", { count: parsedShots.length }));
    } catch (error) {
      toast.error(t("dramaSplitFailed", { message: getErrorMessage(error) }));
    } finally {
      setSplitting(false);
    }
  }

  const createProject = async () => {
    if (!workspaceId) {
      toast.error(t("dramaNeedMediaSelection"));
      return;
    }
    try {
      const project = await dramaService.createProject({ workspaceId, title: t("dramaNewProjectTitle", { number: projects.length + 1 }) });
      setProjects((current) => [project, ...current]);
      setSelectedDramaId(project.id);
    } catch (error) {
      toast.error(t("dramaLoadFailed", { message: getErrorMessage(error) }));
    }
  };

  const createEpisode = async () => {
    if (!selectedDramaId) return;
    try {
      const episode = await dramaService.createEpisode({ dramaId: selectedDramaId, title: t("dramaNewEpisodeTitle", { number: episodes.length + 1 }) });
      setEpisodes((current) => [...current, episode]);
      setSelectedEpisodeId(episode.id);
    } catch (error) {
      toast.error(t("dramaLoadFailed", { message: getErrorMessage(error) }));
    }
  };

  const saveScreenplay = async () => {
    if (!selectedEpisodeId || screenplayDraft === (selectedEpisode?.screenplay ?? "")) return;
    try {
      const updated = await dramaService.updateEpisode(selectedEpisodeId, { screenplay: screenplayDraft });
      setEpisodes((current) => current.map((episode) => episode.id === updated.id ? updated : episode));
    } catch (error) {
      toast.error(t("dramaSaveFailed", { message: getErrorMessage(error) }));
    }
  };

  const addShot = async () => {
    if (!selectedEpisodeId) return;
    try {
      const shot = await dramaService.createShot({ episodeId: selectedEpisodeId });
      setShots((current) => [...current, shot]);
    } catch (error) {
      toast.error(t("dramaSaveFailed", { message: getErrorMessage(error) }));
    }
  };

  const patchShotField = async (shot: DramaShot, patch: { title?: string; dialogue?: string; prompt?: string }) => {
    try {
      patchShotInState(await dramaService.updateShot(shot.id, patch));
    } catch (error) {
      toast.error(t("dramaSaveFailed", { message: getErrorMessage(error) }));
    }
  };

  const removeShot = async (shot: DramaShot) => {
    try {
      await dramaService.deleteShot(shot.id);
      setShots((current) => current.filter((candidate) => candidate.id !== shot.id));
    } catch (error) {
      toast.error(t("dramaSaveFailed", { message: getErrorMessage(error) }));
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden" data-testid="drama-studio">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-[var(--app-border)] px-4 py-1.5" style={{ background: "var(--app-menubar)" }}>
        <Clapperboard className="size-4 shrink-0" style={{ color: "var(--app-accent)" }} aria-hidden="true" />
        <h1 className="truncate text-sm font-semibold" style={{ color: "var(--app-text-primary)" }}>{t("dramaStudioTitle")}</h1>
        <span className="hidden truncate text-[10px] sm:inline" style={{ color: "var(--app-text-tertiary)" }}>
          {workspaceId && projectId ? t("dramaStudioSubtitle") : t("dramaNeedMediaSelection")}
        </span>
      </header>
      <div className="flex min-h-0 flex-1">
        <DramaSidebar
          projects={projects}
          selectedDramaId={selectedDramaId}
          onSelectProject={setSelectedDramaId}
          onCreateProject={() => void createProject()}
          episodes={episodes}
          selectedEpisodeId={selectedEpisodeId}
          onSelectEpisode={setSelectedEpisodeId}
          onCreateEpisode={() => void createEpisode()}
        />
        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          {!selectedEpisode ? (
            <div className="flex flex-1 items-center justify-center px-8 text-center text-sm" style={{ color: "var(--app-text-tertiary)" }}>
              {t("dramaSelectEpisodeHint")}
            </div>
          ) : (
            <DramaEpisodeEditor
              screenplayDraft={screenplayDraft}
              onScreenplayChange={setScreenplayDraft}
              onScreenplayBlur={() => void saveScreenplay()}
              llmProviders={eligibleLlmProviders}
              splitProviderId={splitProvider?.id ?? null}
              onSplitProviderChange={setSplitProviderId}
              splitting={splitting}
              onSplit={() => void splitScreenplay()}
              shots={shots}
              generating={generating}
              batchTargets={batchTargets}
              restyleEligible={restyleEligible}
              previews={previews}
              selectedShotIds={selectedShotIds}
              onToggleShot={(shotId, checked) => setSelectedShotIds((current) => {
                const next = { ...current };
                if (checked) next[shotId] = true;
                else delete next[shotId];
                return next;
              })}
              runStatusLabel={runStatusLabel}
              onAddShot={() => void addShot()}
              onBatchImages={() => void runBatch(batchTargets.filter((shot) => !shot.imageRunId), generateShotImage)}
              onBatchVideos={() => void runBatch(batchTargets.filter((shot) => !shot.videoRunId), generateShotVideo)}
              onOpenRestyle={() => setRestyleOpen(true)}
              onGenerateImage={(shot, index) => void generateShotImage(shot).catch((error) => toast.error(t("dramaGenerateFailed", { title: shot.title || `#${index + 1}`, message: getErrorMessage(error) })))}
              onGenerateVideo={(shot, index) => void generateShotVideo(shot).catch((error) => toast.error(t("dramaGenerateFailed", { title: shot.title || `#${index + 1}`, message: getErrorMessage(error) })))}
              onPatchShot={(shot, patch) => void patchShotField(shot, patch)}
              onRemoveShot={(shot) => void removeShot(shot)}
            />
          )}
        </main>
      </div>
      <BatchRestyleDialog
        open={restyleOpen}
        onOpenChange={setRestyleOpen}
        eligibleCount={restyleEligible.length}
        onSubmit={restyleBatch}
      />
    </div>
  );
}
