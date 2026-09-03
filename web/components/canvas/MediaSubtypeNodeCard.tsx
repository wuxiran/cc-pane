import { useEffect, useMemo, useState } from "react";
import { Music, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { convertFileSrc } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { mediaService } from "@/services/mediaService";
import { isTauriRuntime } from "@/services/runtime";
import { useMediaStore } from "@/stores/useMediaStore";
import type { CanvasNodeProjection, CanvasStoryboardShot } from "@/types/canvas";
import { getErrorMessage } from "@/utils";

interface MediaSubtypeNodeCardProps {
  node: CanvasNodeProjection;
}

function durableNodeId(projectionId: string): string {
  return projectionId.startsWith("media:") ? projectionId.slice("media:".length) : projectionId;
}

/** Resolve a user-entered audio source into a playable URL. */
function resolveAudioSrc(source: string | undefined): string | undefined {
  const trimmed = source?.trim();
  if (!trimmed) return undefined;
  if (/^(https?|asset|blob|data):/i.test(trimmed)) return trimmed;
  // A bare filesystem path only plays in the Tauri runtime via the asset
  // protocol; the web build shows the path without a player.
  return isTauriRuntime() ? convertFileSrc(trimmed) : undefined;
}

/**
 * Inline editors for non-generation media nodes (text/script/board/audio/
 * storyboard). Saves merge into the durable `parameters` bag and re-project
 * through the media store, so the graph stays the single source of truth.
 */
export default function MediaSubtypeNodeCard({ node }: MediaSubtypeNodeCardProps) {
  const { t } = useTranslation("media");
  const media = node.media;
  const nodeId = durableNodeId(node.id);
  const [saving, setSaving] = useState(false);

  const saveParameters = async (patch: Record<string, unknown>) => {
    setSaving(true);
    try {
      const merged = { ...(media?.nodeParameters ?? {}), ...patch };
      await mediaService.updateNode(nodeId, { parameters: merged });
      await useMediaStore.getState().refreshCurrent();
    } catch (error) {
      toast.error(t("nodeUpdateFailed", { message: getErrorMessage(error) }));
    } finally {
      setSaving(false);
    }
  };

  if (!media?.subtype) return null;

  if (media.subtype === "audio") {
    return <AudioNodeBody source={media.audioSource} saving={saving} onSave={(audioSource) => void saveParameters({ audioSource })} />;
  }
  if (media.subtype === "storyboard") {
    return <StoryboardNodeBody shots={media.shots ?? []} saving={saving} onSave={(shots) => void saveParameters({ shots })} />;
  }
  return (
    <TextNodeBody
      subtype={media.subtype}
      value={media.contentText ?? ""}
      saving={saving}
      onSave={(contentText) => void saveParameters({ contentText })}
    />
  );
}

function TextNodeBody({ subtype, value, saving, onSave }: {
  subtype: "text" | "script" | "board";
  value: string;
  saving: boolean;
  onSave: (value: string) => void;
}) {
  const { t } = useTranslation("media");
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const background = subtype === "board"
    ? "color-mix(in srgb, var(--app-status-warning) 12%, var(--app-panel-bg))"
    : "var(--app-panel-bg)";
  return (
    <div className="flex h-full flex-col" style={{ background }}>
      <textarea
        className="min-h-0 w-full flex-1 resize-none bg-transparent p-2 font-mono text-[11px] leading-relaxed outline-none"
        style={{ color: "var(--app-text-primary)" }}
        data-testid="media-subtype-text"
        value={draft}
        placeholder={t(subtype === "script" ? "nodeScriptPlaceholder" : subtype === "board" ? "nodeBoardPlaceholder" : "nodeTextPlaceholder")}
        disabled={saving}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => { if (draft !== value) onSave(draft); }}
      />
    </div>
  );
}

function AudioNodeBody({ source, saving, onSave }: {
  source: string | undefined;
  saving: boolean;
  onSave: (value: string) => void;
}) {
  const { t } = useTranslation("media");
  const [draft, setDraft] = useState(source ?? "");
  useEffect(() => setDraft(source ?? ""), [source]);
  const audioSrc = useMemo(() => resolveAudioSrc(source), [source]);
  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <div className="flex items-center gap-1.5">
        <Music className="size-3.5 shrink-0" style={{ color: "var(--app-accent)" }} aria-hidden="true" />
        <Input
          className="h-7 flex-1 text-[11px]"
          data-testid="media-subtype-audio-source"
          value={draft}
          placeholder={t("nodeAudioSourcePlaceholder")}
          disabled={saving}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => { if (draft.trim() !== (source ?? "").trim()) onSave(draft.trim()); }}
        />
      </div>
      {audioSrc ? (
        <audio className="w-full" controls preload="metadata" src={audioSrc} data-testid="media-subtype-audio-player" />
      ) : (
        <p className="px-1 text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>
          {source?.trim() ? t("nodeAudioUnavailable") : t("nodeAudioHint")}
        </p>
      )}
    </div>
  );
}

function StoryboardNodeBody({ shots, saving, onSave }: {
  shots: CanvasStoryboardShot[];
  saving: boolean;
  onSave: (shots: CanvasStoryboardShot[]) => void;
}) {
  const { t } = useTranslation("media");
  const [draft, setDraft] = useState<CanvasStoryboardShot[]>(shots);
  useEffect(() => setDraft(shots), [shots]);

  const patchShot = (id: string, patch: Partial<CanvasStoryboardShot>) => {
    setDraft((current) => current.map((shot) => shot.id === id ? { ...shot, ...patch } : shot));
  };
  const commit = (next: CanvasStoryboardShot[] = draft) => onSave(next);

  return (
    <div className="flex h-full flex-col">
      <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-2 gap-1.5 overflow-y-auto p-1.5">
        {draft.length === 0 ? (
          <p className="col-span-2 px-2 py-4 text-center text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>{t("storyboardEmpty")}</p>
        ) : null}
        {draft.map((shot, index) => (
          <div
            key={shot.id}
            className="flex flex-col gap-1 rounded border p-1.5"
            style={{ borderColor: "color-mix(in srgb, var(--app-border) 80%, transparent)", background: "color-mix(in srgb, var(--app-panel-bg) 78%, black)" }}
            data-testid={`storyboard-shot-${shot.id}`}
          >
            {shot.previewUrl ? (
              <img src={shot.previewUrl} alt={shot.title ?? ""} className="h-16 w-full rounded object-cover" loading="lazy" decoding="async" />
            ) : null}
            <div className="flex items-center gap-1">
              <span className="shrink-0 text-[9px] tabular-nums" style={{ color: "var(--app-text-tertiary)" }}>#{index + 1}</span>
              <input
                className="min-w-0 flex-1 bg-transparent text-[10px] font-semibold outline-none"
                style={{ color: "var(--app-text-primary)" }}
                value={shot.title ?? ""}
                placeholder={t("storyboardShotTitle")}
                disabled={saving}
                onChange={(event) => patchShot(shot.id, { title: event.target.value })}
                onBlur={() => commit()}
              />
              <button
                type="button"
                className="shrink-0 rounded p-0.5 transition-colors hover:bg-[var(--app-hover)]"
                style={{ color: "var(--app-text-tertiary)" }}
                aria-label={t("storyboardRemoveShot")}
                title={t("storyboardRemoveShot")}
                disabled={saving}
                onClick={() => {
                  const next = draft.filter((candidate) => candidate.id !== shot.id);
                  setDraft(next);
                  commit(next);
                }}
              >
                <Trash2 className="size-3" aria-hidden="true" />
              </button>
            </div>
            <textarea
              className="h-12 w-full resize-none rounded bg-transparent text-[10px] leading-snug outline-none"
              style={{ color: "var(--app-text-secondary)" }}
              value={shot.prompt ?? ""}
              placeholder={t("storyboardShotPrompt")}
              disabled={saving}
              onChange={(event) => patchShot(shot.id, { prompt: event.target.value })}
              onBlur={() => commit()}
            />
          </div>
        ))}
      </div>
      <div className="shrink-0 border-t p-1.5" style={{ borderColor: "color-mix(in srgb, var(--app-border) 80%, transparent)" }}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-6 w-full text-[10px]"
          disabled={saving}
          onClick={() => {
            const next = [...draft, { id: crypto.randomUUID() }];
            setDraft(next);
            commit(next);
          }}
        >
          <Plus className="size-3" aria-hidden="true" />
          {t("storyboardAddShot")}
        </Button>
      </div>
    </div>
  );
}
