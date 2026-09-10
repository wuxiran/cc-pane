import { useCallback, useEffect, useMemo, useState } from "react";
import { Clapperboard } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toastErr, toastOk } from "@/lib/feedback";
import DramaEpisodeEditor from "./DramaEpisodeEditor";
import DramaSidebar from "./DramaSidebar";
import { SPLIT_SYSTEM_PROMPT, parseShotsReply } from "./dramaSplit";
import { completePrompt, supportsPromptCompletion } from "@/services/promptCopilotService";
import { dramaService } from "@/services/dramaService";
import { useProvidersStore, useWorkspacesStore } from "@/stores";
import { getErrorMessage } from "@/utils";
import type { DramaEpisode, DramaProject, DramaShot } from "@/types/drama";

export default function DramaStudio() {
  const { t } = useTranslation("drama");
  const providers = useProvidersStore((state) => state.providers);
  const eligibleLlmProviders = useMemo(() => providers.filter(supportsPromptCompletion), [providers]);
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const workspaceId = workspaces[0]?.id ?? null;

  const [projects, setProjects] = useState<DramaProject[]>([]);
  const [selectedDramaId, setSelectedDramaId] = useState<string | null>(null);
  const [episodes, setEpisodes] = useState<DramaEpisode[]>([]);
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string | null>(null);
  const [shots, setShots] = useState<DramaShot[]>([]);
  const [screenplayDraft, setScreenplayDraft] = useState("");
  const [splitProviderId, setSplitProviderId] = useState<string | null>(null);
  const [splitting, setSplitting] = useState(false);

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
      toastErr(t("dramaLoadFailed", { message: getErrorMessage(error) }));
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
      toastErr(t("dramaLoadFailed", { message: getErrorMessage(error) }));
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
      toastErr(t("dramaLoadFailed", { message: getErrorMessage(error) }));
    }
  }, [selectedEpisodeId, t]);

  useEffect(() => { void loadProjects(); }, [loadProjects]);
  useEffect(() => { void loadEpisodes(); }, [loadEpisodes]);
  useEffect(() => { void loadShots(); }, [loadShots]);
  useEffect(() => {
    setScreenplayDraft(selectedEpisode?.screenplay ?? "");
  }, [selectedEpisode?.id, selectedEpisode?.screenplay]);

  async function splitScreenplay() {
    if (!selectedEpisodeId || !screenplayDraft.trim()) return;
    if (!splitProvider) {
      toastErr(t("copilotNoProviders"));
      return;
    }
    const modelId = splitProvider.defaultModelId ?? splitProvider.models?.[0]?.id;
    if (!modelId) {
      toastErr(t("dramaSplitNoModel"));
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
      toastOk(t("dramaSplitDone", { count: parsedShots.length }));
    } catch (error) {
      toastErr(t("dramaSplitFailed", { message: getErrorMessage(error) }));
    } finally {
      setSplitting(false);
    }
  }

  const createProject = async () => {
    if (!workspaceId) {
      toastErr(t("dramaNeedMediaSelection"));
      return;
    }
    try {
      const project = await dramaService.createProject({ workspaceId, title: t("dramaNewProjectTitle", { number: projects.length + 1 }) });
      setProjects((current) => [project, ...current]);
      setSelectedDramaId(project.id);
    } catch (error) {
      toastErr(t("dramaLoadFailed", { message: getErrorMessage(error) }));
    }
  };

  const createEpisode = async () => {
    if (!selectedDramaId) return;
    try {
      const episode = await dramaService.createEpisode({ dramaId: selectedDramaId, title: t("dramaNewEpisodeTitle", { number: episodes.length + 1 }) });
      setEpisodes((current) => [...current, episode]);
      setSelectedEpisodeId(episode.id);
    } catch (error) {
      toastErr(t("dramaLoadFailed", { message: getErrorMessage(error) }));
    }
  };

  const saveScreenplay = async () => {
    if (!selectedEpisodeId || screenplayDraft === (selectedEpisode?.screenplay ?? "")) return;
    try {
      const updated = await dramaService.updateEpisode(selectedEpisodeId, { screenplay: screenplayDraft });
      setEpisodes((current) => current.map((episode) => episode.id === updated.id ? updated : episode));
    } catch (error) {
      toastErr(t("dramaSaveFailed", { message: getErrorMessage(error) }));
    }
  };

  const addShot = async () => {
    if (!selectedEpisodeId) return;
    try {
      const shot = await dramaService.createShot({ episodeId: selectedEpisodeId });
      setShots((current) => [...current, shot]);
    } catch (error) {
      toastErr(t("dramaSaveFailed", { message: getErrorMessage(error) }));
    }
  };

  const patchShotField = async (shot: DramaShot, patch: { title?: string; dialogue?: string; prompt?: string }) => {
    try {
      const updated = await dramaService.updateShot(shot.id, patch);
      setShots((current) => current.map((s) => s.id === updated.id ? updated : s));
    } catch (error) {
      toastErr(t("dramaSaveFailed", { message: getErrorMessage(error) }));
    }
  };

  const removeShot = async (shot: DramaShot) => {
    try {
      await dramaService.deleteShot(shot.id);
      setShots((current) => current.filter((candidate) => candidate.id !== shot.id));
    } catch (error) {
      toastErr(t("dramaSaveFailed", { message: getErrorMessage(error) }));
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden" data-testid="drama-studio">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-[var(--app-border)] px-4 py-1.5" style={{ background: "var(--app-menubar)" }}>
        <Clapperboard className="size-4 shrink-0" style={{ color: "var(--app-accent)" }} aria-hidden="true" />
        <h1 className="truncate text-sm font-semibold" style={{ color: "var(--app-text-primary)" }}>{t("dramaStudioTitle")}</h1>
        <span className="hidden truncate text-[10px] sm:inline" style={{ color: "var(--app-text-tertiary)" }}>
          {t("dramaStudioSubtitle")}
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
              onAddShot={() => void addShot()}
              onPatchShot={(shot, patch) => void patchShotField(shot, patch)}
              onRemoveShot={(shot) => void removeShot(shot)}
            />
          )}
        </main>
      </div>
    </div>
  );
}