// 单集编辑区：剧本 + LLM 拆分镜 + 分镜列表（每镜生图/生视频/删除）。
// 从 DramaStudio 拆出（行数棘轮）；状态与副作用全留在父组件，这里只渲染与回调。
import { Film, ImagePlus, Loader2, Paintbrush, Plus, Sparkles, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { DramaShot } from "@/types/drama";

export interface DramaShotPatch {
  title?: string;
  dialogue?: string;
  prompt?: string;
}

export interface DramaEpisodeEditorProps {
  screenplayDraft: string;
  onScreenplayChange: (value: string) => void;
  onScreenplayBlur: () => void;
  llmProviders: { id: string; name: string }[];
  splitProviderId: string | null;
  onSplitProviderChange: (id: string) => void;
  splitting: boolean;
  onSplit: () => void;
  shots: DramaShot[];
  generating: boolean;
  batchTargets: DramaShot[];
  restyleEligible: DramaShot[];
  previews: Record<string, string>;
  selectedShotIds: Record<string, true>;
  onToggleShot: (shotId: string, checked: boolean) => void;
  runStatusLabel: (runId: string | null | undefined) => string;
  onAddShot: () => void;
  onBatchImages: () => void;
  onBatchVideos: () => void;
  onOpenRestyle: () => void;
  onGenerateImage: (shot: DramaShot, index: number) => void;
  onGenerateVideo: (shot: DramaShot, index: number) => void;
  onPatchShot: (shot: DramaShot, patch: DramaShotPatch) => void;
  onRemoveShot: (shot: DramaShot) => void;
}

export default function DramaEpisodeEditor(props: DramaEpisodeEditorProps) {
  const { t } = useTranslation("media");
  const {
    screenplayDraft, onScreenplayChange, onScreenplayBlur,
    llmProviders, splitProviderId, onSplitProviderChange, splitting, onSplit,
    shots, generating, batchTargets, restyleEligible, previews, selectedShotIds, onToggleShot,
    runStatusLabel, onAddShot, onBatchImages, onBatchVideos, onOpenRestyle,
    onGenerateImage, onGenerateVideo, onPatchShot, onRemoveShot,
  } = props;

  return (
    <>
      <section className="border-b border-[var(--app-border)] p-3">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold" style={{ color: "var(--app-text-secondary)" }}>{t("dramaScreenplay")}</span>
          <div className="ml-auto flex items-center gap-2">
            {llmProviders.length > 1 ? (
              <Select value={splitProviderId ?? ""} onValueChange={onSplitProviderChange}>
                <SelectTrigger size="sm" className="h-7 w-36 text-[11px]">
                  <SelectValue placeholder={t("copilotProvider")} />
                </SelectTrigger>
                <SelectContent>
                  {llmProviders.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>{candidate.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <Button
              type="button"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              disabled={splitting || !screenplayDraft.trim()}
              onClick={onSplit}
              data-testid="drama-split-shots"
            >
              {splitting ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <Sparkles className="size-3.5" aria-hidden="true" />}
              {splitting ? t("dramaSplitting") : t("dramaSplitShots")}
            </Button>
          </div>
        </div>
        <textarea
          className="h-36 w-full resize-y rounded-md border bg-transparent p-2 text-xs leading-relaxed outline-none"
          style={{ borderColor: "var(--app-border)", color: "var(--app-text-primary)" }}
          data-testid="drama-screenplay"
          value={screenplayDraft}
          placeholder={t("dramaScreenplayPlaceholder")}
          onChange={(event) => onScreenplayChange(event.target.value)}
          onBlur={onScreenplayBlur}
        />
      </section>
      <section className="flex-1 p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold" style={{ color: "var(--app-text-secondary)" }}>{t("dramaShots")}</span>
          <span className="text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>{t("dramaShotCount", { count: shots.length })}</span>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <Button type="button" variant="outline" size="sm" className="h-7 gap-1 text-[11px]" onClick={onAddShot}>
              <Plus className="size-3" aria-hidden="true" />{t("dramaAddShot")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1 text-[11px]"
              disabled={generating || batchTargets.length === 0}
              onClick={onBatchImages}
              data-testid="drama-batch-images"
            >
              <ImagePlus className="size-3" aria-hidden="true" />{t("dramaBatchImages")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1 text-[11px]"
              disabled={generating || batchTargets.length === 0}
              onClick={onBatchVideos}
              data-testid="drama-batch-videos"
            >
              <Film className="size-3" aria-hidden="true" />{t("dramaBatchVideos")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1 text-[11px]"
              disabled={generating || restyleEligible.length === 0}
              onClick={onOpenRestyle}
              data-testid="drama-batch-restyle"
            >
              <Paintbrush className="size-3" aria-hidden="true" />{t("restyleAction")}
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          {shots.map((shot, index) => {
            const imagePreview = shot.imageRunId ? previews[shot.imageRunId] : undefined;
            const videoPreview = shot.videoRunId ? previews[shot.videoRunId] : undefined;
            return (
              <div
                key={shot.id}
                className="flex gap-2 rounded-md border p-2"
                style={{ borderColor: "var(--app-border)", background: "var(--app-panel-bg)" }}
                data-testid={`drama-shot-${shot.id}`}
              >
                <div className="flex shrink-0 flex-col items-center gap-1 pt-1">
                  <input
                    type="checkbox"
                    checked={Boolean(selectedShotIds[shot.id])}
                    aria-label={t("dramaSelectShot")}
                    onChange={(event) => onToggleShot(shot.id, event.target.checked)}
                  />
                  <span className="text-[10px] tabular-nums" style={{ color: "var(--app-text-tertiary)" }}>#{index + 1}</span>
                </div>
                <div className="flex w-28 shrink-0 flex-col gap-1">
                  {videoPreview ? (
                    <video className="h-20 w-full rounded object-cover" src={videoPreview} controls preload="metadata" playsInline />
                  ) : imagePreview ? (
                    <img className="h-20 w-full rounded object-cover" src={imagePreview} alt={shot.title} loading="lazy" decoding="async" />
                  ) : (
                    <div className="flex h-20 w-full items-center justify-center rounded text-[9px]" style={{ background: "color-mix(in srgb, var(--app-panel-bg) 70%, black)", color: "var(--app-text-tertiary)" }}>
                      {t("dramaNoPreview")}
                    </div>
                  )}
                  <span className="truncate text-[9px]" style={{ color: "var(--app-text-tertiary)" }}>
                    {t("dramaImageStatus")}: {runStatusLabel(shot.imageRunId)} · {t("dramaVideoStatus")}: {runStatusLabel(shot.videoRunId)}
                  </span>
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <Input
                    className="h-6 text-[11px]"
                    defaultValue={shot.title}
                    placeholder={t("storyboardShotTitle")}
                    onBlur={(event) => { if (event.target.value !== shot.title) onPatchShot(shot, { title: event.target.value }); }}
                  />
                  <textarea
                    className="h-10 w-full resize-none rounded border bg-transparent p-1 text-[10px] outline-none"
                    style={{ borderColor: "var(--app-border)", color: "var(--app-text-secondary)" }}
                    defaultValue={shot.dialogue}
                    placeholder={t("dramaDialoguePlaceholder")}
                    onBlur={(event) => { if (event.target.value !== shot.dialogue) onPatchShot(shot, { dialogue: event.target.value }); }}
                  />
                  <textarea
                    className="h-12 w-full resize-none rounded border bg-transparent p-1 text-[10px] outline-none"
                    style={{ borderColor: "var(--app-border)", color: "var(--app-text-primary)" }}
                    defaultValue={shot.prompt}
                    placeholder={t("storyboardShotPrompt")}
                    onBlur={(event) => { if (event.target.value !== shot.prompt) onPatchShot(shot, { prompt: event.target.value }); }}
                  />
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  <Button type="button" variant="outline" size="sm" className="h-6 gap-1 px-2 text-[10px]" disabled={generating} onClick={() => onGenerateImage(shot, index)}>
                    <ImagePlus className="size-3" aria-hidden="true" />{t("dramaGenerateImage")}
                  </Button>
                  <Button type="button" variant="outline" size="sm" className="h-6 gap-1 px-2 text-[10px]" disabled={generating} onClick={() => onGenerateVideo(shot, index)}>
                    <Film className="size-3" aria-hidden="true" />{t("dramaGenerateVideo")}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" className="h-6 gap-1 px-2 text-[10px]" onClick={() => onRemoveShot(shot)}>
                    <Trash2 className="size-3" aria-hidden="true" />{t("storyboardRemoveShot")}
                  </Button>
                </div>
              </div>
            );
          })}
          {shots.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("dramaNoShots")}</p>
          ) : null}
        </div>
      </section>
    </>
  );
}
