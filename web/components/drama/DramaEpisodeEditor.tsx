// 单集编辑区：剧本 + LLM 拆分镜 + 分镜列表（纯文本编辑）。
// 从 DramaStudio 拆出（行数棘轮）；状态与副作用全留在父组件，这里只渲染与回调。
import { Loader2, Plus, Sparkles, Trash2 } from "lucide-react";
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
  onAddShot: () => void;
  onPatchShot: (shot: DramaShot, patch: DramaShotPatch) => void;
  onRemoveShot: (shot: DramaShot) => void;
}

export default function DramaEpisodeEditor(props: DramaEpisodeEditorProps) {
  const { t } = useTranslation("drama");
  const {
    screenplayDraft, onScreenplayChange, onScreenplayBlur,
    llmProviders, splitProviderId, onSplitProviderChange, splitting, onSplit,
    shots, onAddShot, onPatchShot, onRemoveShot,
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
          </div>
        </div>
        <div className="flex flex-col gap-2">
          {shots.map((shot, index) => (
            <div
              key={shot.id}
              className="flex gap-2 rounded-md border p-2"
              style={{ borderColor: "var(--app-border)", background: "var(--app-panel-bg)" }}
              data-testid={`drama-shot-${shot.id}`}
            >
              <div className="flex shrink-0 flex-col items-center gap-1 pt-1">
                <span className="text-[10px] tabular-nums" style={{ color: "var(--app-text-tertiary)" }}>#{index + 1}</span>
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
                <Button type="button" variant="ghost" size="sm" className="h-6 gap-1 px-2 text-[10px]" onClick={() => onRemoveShot(shot)}>
                  <Trash2 className="size-3" aria-hidden="true" />{t("storyboardRemoveShot")}
                </Button>
              </div>
            </div>
          ))}
          {shots.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("dramaNoShots")}</p>
          ) : null}
        </div>
      </section>
    </>
  );
}