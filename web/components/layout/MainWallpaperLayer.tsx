// 主区壁纸层：挂在 MainViewSwitcher 的 panes 容器内（不挂 AppShell，避免铺到
// TitleBar/ActivityBar/StatusBar 底下）。遵循装饰层惯例（参考 DarkOrbsBackground）：
// absolute inset-0 z-0 pointer-events-none + aria-hidden。
// 内部自下而上：媒体层（img / video）→ blur/scale 容器 → dim 遮罩。
//
// 视频禁区（docs/39）：禁止隐藏 WebView 窗口做壁纸（失效 WebView2 emit 洪水）、
// 禁止 WebGL/canvas 渲染视频帧（争抢 live context 预算）。必须用原生 <video
// muted playsInline loop preload="metadata">，声音一律走独立 audio（阶段 3）。
import { useEffect, useRef } from "react";
import { useWallpaperStore } from "@/stores/useWallpaperStore";
import { useMiniModeStore } from "@/stores/useMiniModeStore";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { isTauriRuntime } from "@/services/runtime";
import type { WallpaperFit } from "@/types";

const FIT_STYLES: Record<WallpaperFit, React.CSSProperties> = {
  cover: { backgroundSize: "cover", backgroundRepeat: "no-repeat", backgroundPosition: "center" },
  contain: {
    backgroundSize: "contain",
    backgroundRepeat: "no-repeat",
    backgroundPosition: "center",
  },
  tile: { backgroundSize: "auto", backgroundRepeat: "repeat", backgroundPosition: "top left" },
  center: { backgroundSize: "auto", backgroundRepeat: "no-repeat", backgroundPosition: "center" },
};

const VIDEO_FIT: Record<WallpaperFit, React.CSSProperties["objectFit"]> = {
  cover: "cover",
  contain: "contain",
  tile: "cover",
  center: "none",
};

export default function MainWallpaperLayer() {
  const resolved = useWallpaperStore((s) => s.resolved);
  const assetUrl = useWallpaperStore((s) => s.assetUrl);
  const videoPolicy = useWallpaperStore((s) => s.videoPolicy);
  const markVideoDecodeFailed = useWallpaperStore((s) => s.markVideoDecodeFailed);
  const isMiniMode = useMiniModeStore((s) => s.isMiniMode);
  const appViewMode = useActivityBarStore((s) => s.appViewMode);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const active = resolved !== null && assetUrl !== null;

  const showVideo = active && resolved.kind === "video" && videoPolicy?.mode === "video";
  const pauseWhenUnfocused = resolved?.video.pauseWhenUnfocused ?? true;
  const playbackRate = resolved?.video.playbackRate ?? 1;
  const videoAutoplay = resolved?.video.autoplay ?? true;
  // 运行时暂停（不改 mode，只 pause）：hidden / blur（按设置）/ MiniMode / 主视图切走 panes
  const viewVisible = appViewMode === "panes" || appViewMode === "orchestration";

  // orbs 的 mix-blend-screen 叠在照片上会洗白：壁纸激活时在文档根把 orbs 压到 0。
  // orbs 层挂在 AppShell（主区根节点之外），只能走文档根 token。
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    root.style.setProperty("--app-orbs-opacity", "0");
    return () => {
      root.style.removeProperty("--app-orbs-opacity");
    };
  }, [active]);

  // 视频起停：低频信号（设置/视图/焦点），不进入 resize 等高频路径
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !showVideo) return;

    video.playbackRate = playbackRate;
    const syncPlayback = () => {
      const shouldPlay =
        videoAutoplay &&
        viewVisible &&
        !isMiniMode &&
        document.visibilityState !== "hidden" &&
        (!pauseWhenUnfocused || document.hasFocus());
      if (shouldPlay) {
        void video.play().catch(() => {
          // muted 视频 autoplay 一般不会被拒；失败静默停在首帧
        });
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
  }, [showVideo, playbackRate, videoAutoplay, viewVisible, isMiniMode, pauseWhenUnfocused]);

  if (!isTauriRuntime()) return null;
  if (!active || !resolved) return null;

  const blur = resolved.blur > 0 ? resolved.blur : 0;

  return (
    <div
      aria-hidden="true"
      className="absolute inset-0 z-0 pointer-events-none overflow-hidden"
      data-wallpaper-layer=""
    >
      {/* blur/scale 容器：blur 时轻微放大，避免边缘露出透明晕边 */}
      <div
        className="absolute inset-0"
        style={{
          filter: blur > 0 ? `blur(${blur}px)` : undefined,
          transform: blur > 0 ? "scale(1.06)" : undefined,
        }}
      >
        {resolved.kind === "image" && (
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: `url("${assetUrl}")`,
              opacity: resolved.opacity,
              ...FIT_STYLES[resolved.fit],
            }}
          />
        )}
        {showVideo && (
          <video
            ref={videoRef}
            className="absolute inset-0 h-full w-full"
            style={{ opacity: resolved.opacity, objectFit: VIDEO_FIT[resolved.fit] }}
            src={assetUrl ?? undefined}
            muted
            playsInline
            loop
            preload="metadata"
            onError={() => markVideoDecodeFailed()}
          />
        )}
        {/* poster 降级：MVP 不抽帧，回落纯色 dim 层（下方遮罩即是） */}
      </div>
      {/* dim 遮罩：保证前景文字对比度 */}
      {resolved.dim > 0 && (
        <div
          className="absolute inset-0"
          style={{ background: "#000", opacity: resolved.dim }}
        />
      )}
    </div>
  );
}
