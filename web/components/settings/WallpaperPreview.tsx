import { useEffect, useRef } from "react";
import type { WallpaperFit, WallpaperSettings } from "@/types";

interface WallpaperPreviewProps {
  wallpaper: WallpaperSettings;
  assetUrl: string | null;
  label: string;
}

const IMAGE_FIT_STYLES: Record<WallpaperFit, React.CSSProperties> = {
  cover: { backgroundPosition: "center", backgroundRepeat: "no-repeat", backgroundSize: "cover" },
  contain: { backgroundPosition: "center", backgroundRepeat: "no-repeat", backgroundSize: "contain" },
  tile: { backgroundPosition: "top left", backgroundRepeat: "repeat", backgroundSize: "auto" },
  center: { backgroundPosition: "center", backgroundRepeat: "no-repeat", backgroundSize: "auto" },
};

const VIDEO_FIT_STYLES: Record<WallpaperFit, React.CSSProperties["objectFit"]> = {
  cover: "cover",
  contain: "contain",
  tile: "cover",
  center: "none",
};

export default function WallpaperPreview({
  wallpaper,
  assetUrl,
  label,
}: WallpaperPreviewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const active =
    wallpaper.enabled &&
    assetUrl !== null &&
    (wallpaper.kind === "image" || wallpaper.kind === "video");
  const showVideo = active && wallpaper.kind === "video";

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !showVideo) return;

    video.playbackRate = wallpaper.video.playbackRate;
    const syncPlayback = () => {
      const shouldPlay =
        wallpaper.video.autoplay &&
        wallpaper.video.powerSaver !== "always" &&
        document.visibilityState !== "hidden" &&
        (!wallpaper.video.pauseWhenUnfocused || document.hasFocus());
      if (shouldPlay) {
        void video.play().catch(() => {});
      } else {
        video.pause();
      }
    };

    syncPlayback();
    document.addEventListener("visibilitychange", syncPlayback);
    window.addEventListener("blur", syncPlayback);
    window.addEventListener("focus", syncPlayback);
    return () => {
      document.removeEventListener("visibilitychange", syncPlayback);
      window.removeEventListener("blur", syncPlayback);
      window.removeEventListener("focus", syncPlayback);
      video.pause();
    };
  }, [
    showVideo,
    wallpaper.video.autoplay,
    wallpaper.video.pauseWhenUnfocused,
    wallpaper.video.playbackRate,
    wallpaper.video.powerSaver,
  ]);

  const blur = wallpaper.blur > 0 ? wallpaper.blur : 0;
  const terminalOpacity = active ? wallpaper.terminalOpacity : 1;

  return (
    <div className="space-y-1.5 pt-1">
      <span className="text-xs" style={{ color: "var(--app-text-secondary)" }}>
        {label}
      </span>
      <div
        aria-label={label}
        className="relative h-[120px] w-full overflow-hidden rounded-md"
        data-active={active}
        data-testid="wallpaper-preview"
        style={{
          background: "var(--app-terminal-bg)",
          border: "1px solid var(--app-border)",
        }}
      >
        {active && (
          <div
            className="absolute inset-0"
            data-testid="wallpaper-preview-media-frame"
            style={{
              filter: blur > 0 ? `blur(${blur}px)` : undefined,
              transform: blur > 0 ? "scale(1.06)" : undefined,
            }}
          >
            {wallpaper.kind === "image" && (
              <div
                className="absolute inset-0"
                data-testid="wallpaper-preview-image"
                style={{
                  backgroundImage: `url("${assetUrl}")`,
                  opacity: wallpaper.opacity,
                  ...IMAGE_FIT_STYLES[wallpaper.fit],
                }}
              />
            )}
            {showVideo && (
              <video
                ref={videoRef}
                className="absolute inset-0 h-full w-full"
                data-testid="wallpaper-preview-video"
                loop
                muted
                playsInline
                preload="metadata"
                src={assetUrl}
                style={{
                  objectFit: VIDEO_FIT_STYLES[wallpaper.fit],
                  opacity: wallpaper.opacity,
                }}
              />
            )}
          </div>
        )}

        {active && wallpaper.dim > 0 && (
          <div
            className="absolute inset-0"
            data-testid="wallpaper-preview-dim"
            style={{ background: "#000", opacity: wallpaper.dim }}
          />
        )}

        <div
          className="relative z-10 h-full p-2 font-mono text-[10px] leading-tight"
          data-terminal-opacity={terminalOpacity}
          data-testid="wallpaper-preview-terminal"
          style={{
            backdropFilter: active ? `blur(${wallpaper.glassBlur}px)` : undefined,
            background: active
              ? `color-mix(in srgb, var(--app-terminal-bg) ${Math.round(terminalOpacity * 100)}%, transparent)`
              : "var(--app-terminal-bg)",
            color: "var(--app-terminal-fg)",
            WebkitBackdropFilter: active ? `blur(${wallpaper.glassBlur}px)` : undefined,
          }}
        >
          <div className="opacity-90">$ pnpm dev</div>
          <div className="opacity-75">VITE v6.0 ready in 234ms</div>
          <div className="opacity-75">&gt; Local: http://localhost:5173/</div>
          <div className="mt-1 opacity-50">$ _</div>
        </div>
      </div>
    </div>
  );
}
