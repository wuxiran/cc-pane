import { useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import MediaSubtypeNodeCard from "./MediaSubtypeNodeCard";
import type { CanvasMediaProjection, CanvasNodeProjection } from "@/types/canvas";

interface MediaNodeCardProps {
  node: CanvasNodeProjection;
}

function mediaLabel(media: CanvasMediaProjection): string {
  if (media.mediaKind === "video") return "Video preview";
  return "Image preview";
}

function videoMetadataLabel(
  media: CanvasMediaProjection,
  translate: TFunction<"orchestration">,
): string | null {
  if (media.mediaKind !== "video") return null;
  const parts: string[] = [];
  if (media.durationMs != null) parts.push(`${(media.durationMs / 1000).toFixed(1)}s`);
  if (media.fps != null) parts.push(`${Number.isInteger(media.fps) ? media.fps : media.fps.toFixed(2)} fps`);
  if (media.codec) parts.push(media.codec);
  if (media.container) parts.push(media.container.split(",")[0]);
  if (media.audio != null) parts.push(media.audio ? "audio" : "silent");
  if (media.audioCodec) {
    const audioDetails = [
      media.audioCodec,
      media.audioChannels != null ? `${media.audioChannels}ch` : null,
      media.sampleRate != null ? `${Math.round(media.sampleRate / 100) / 10}kHz` : null,
    ].filter(Boolean).join(" ");
    if (audioDetails) parts.push(audioDetails);
  }
  if (media.colorSpace) parts.push(media.colorSpace);
  if (media.bitDepth != null) parts.push(`${media.bitDepth}bit`);
  if (media.pixelFormat) parts.push(media.pixelFormat);
  if (media.probeStatus && !["ok", "skipped"].includes(media.probeStatus)) {
    parts.push(translate("canvasMediaProbeUnavailable", { defaultValue: "Metadata probe unavailable" }));
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * DOM media surface for a Canvas media node. The graph layers remain separate;
 * keeping decoding in the browser preserves native video controls and avoids
 * copying video frames into the graph canvas.
 */
export default function MediaNodeCard({ node }: MediaNodeCardProps) {
  const { t } = useTranslation("orchestration");
  const media = node.media;
  const subtype = media?.subtype;
  const [failed, setFailed] = useState(false);
  const [visible, setVisible] = useState(true);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const previewUrl = media?.previewUrl;
  const mediaKind = media?.mediaKind;
  const mediaVersion = media?.updatedAt ?? media?.runId ?? media?.assetId;

  // A refreshed run can replace the asset while keeping the same node id.
  useEffect(() => {
    setFailed(false);
    setVisible(true);
  }, [mediaKind, mediaVersion, previewUrl]);

  // Canvas lives in its own scroll container. Observe against that container
  // so a node that is merely below the fold is treated as off-screen too.
  // Keep a generous margin to avoid decoder churn during a small scroll.
  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const root = element.closest<HTMLElement>("[data-canvas-scroll-root]");
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting ?? true),
      { root: root ?? null, rootMargin: "128px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [node.id, previewUrl]);

  // Release a video decoder when the media source itself is replaced or the
  // node leaves the Canvas. Status-only polls must not interrupt playback.
  useEffect(() => {
    return () => {
      const video = videoRef.current;
      if (!video) return;
      video.pause();
      video.removeAttribute("src");
      try {
        video.load();
      } catch {
        // jsdom and older WebViews may not implement HTMLMediaElement.load().
      }
    };
  }, [mediaKind, previewUrl]);

  if (subtype) return <MediaSubtypeNodeCard node={node} />;

  if (!media) {
    return (
      <div
        data-testid={`canvas-media-empty-${node.id}`}
        className="flex h-full items-center justify-center px-4 text-center text-[11px]"
        style={{ color: "var(--app-text-tertiary)" }}
      >
        {t("canvasMediaNoPreview", { defaultValue: "No media preview" })}
      </div>
    );
  }

  if (!media.previewUrl || failed) {
    return (
      <div
        data-testid={`canvas-media-empty-${node.id}`}
        className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center text-[11px]"
        style={{ color: "var(--app-text-tertiary)" }}
      >
        <span className="max-w-full break-words">{failed
          ? media.errorMessage || t("canvasMediaPreviewUnavailable", { defaultValue: "Preview unavailable" })
          : t("canvasMediaWaiting", { defaultValue: "Waiting for media" })}</span>
        {media.progress !== undefined && !failed ? (
          <span className="tabular-nums text-[10px]">{Math.round(media.progress)}%</span>
        ) : null}
      </div>
    );
  }

  const label = media.alt || node.label || mediaLabel(media);
  const videoMetadata = videoMetadataLabel(media, t);
  const effectivePreviewUrl = visible ? media.previewUrl : undefined;
  const commonProps = {
    className: `block h-full w-full object-contain${visible ? "" : "opacity-0"}`,
    onError: () => setFailed(true),
  };

  return (
    <div
      ref={containerRef}
      data-testid={`canvas-media-${node.id}`}
      className="relative flex h-full min-h-0 w-full items-center justify-center overflow-hidden"
      style={{ background: "color-mix(in srgb, var(--app-panel-bg) 78%, black)" }}
    >
      {media.mediaKind === "video" ? (
        <video
          {...commonProps}
          ref={videoRef}
          key={`${media.previewUrl}:${visible ? "visible" : "suspended"}`}
          data-testid={`canvas-media-video-${node.id}`}
          src={effectivePreviewUrl}
          poster={media.posterUrl}
          aria-label={label}
          onLoadedData={() => setFailed(false)}
          controls
          preload="metadata"
          playsInline
        />
      ) : (
        <img
          {...commonProps}
          data-testid={`canvas-media-image-${node.id}`}
          src={effectivePreviewUrl}
          alt={label}
          onLoad={() => setFailed(false)}
          loading="lazy"
          decoding="async"
        />
      )}
      {!visible ? (
        <div
          data-testid={`canvas-media-offscreen-${node.id}`}
          className="pointer-events-none absolute inset-0 flex items-center justify-center px-3 text-center text-[10px]"
          style={{ color: "var(--app-text-tertiary)" }}
          aria-hidden="true"
        >
          {t("canvasMediaOffscreen", { defaultValue: "Preview paused off-screen" })}
        </div>
      ) : null}
      {videoMetadata ? <div data-testid={`canvas-media-metadata-${node.id}`} title={media.probeReason} className="pointer-events-none absolute left-2 top-2 max-w-[calc(100%-1rem)] truncate rounded bg-black/65 px-1.5 py-1 text-[9px] tabular-nums text-white/85">{videoMetadata}</div> : null}
      {media.progress !== undefined && media.runStatus && media.runStatus !== "succeeded" ? (
        <div
          className="pointer-events-none absolute inset-x-2 bottom-2 h-1 overflow-hidden rounded-full"
          style={{ background: "color-mix(in srgb, var(--app-border) 70%, transparent)" }}
          aria-label={t("canvasMediaProgress", { percent: Math.round(media.progress), defaultValue: `Media progress ${Math.round(media.progress)}%` })}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.max(0, Math.min(100, Math.round(media.progress)))}
        >
          <div
            className="h-full transition-[width]"
            style={{ width: `${Math.max(0, Math.min(100, media.progress))}%`, background: "var(--app-accent)" }}
          />
        </div>
      ) : null}
    </div>
  );
}
