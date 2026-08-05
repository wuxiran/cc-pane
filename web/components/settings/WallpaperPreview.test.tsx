import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import WallpaperPreview from "./WallpaperPreview";
import type { WallpaperSettings } from "@/types";

function wallpaper(overrides: Partial<WallpaperSettings> = {}): WallpaperSettings {
  return {
    enabled: true,
    kind: "image",
    file: "wallpaper.png",
    fit: "cover",
    opacity: 1,
    blur: 0,
    dim: 0.35,
    terminalOpacity: 0.85,
    glassBlur: 0,
    video: {
      autoplay: true,
      playbackRate: 1,
      pauseWhenUnfocused: true,
      powerSaver: "auto",
    },
    music: {
      enabled: false,
      file: null,
      volume: 0.5,
      loopPlayback: true,
      autoplay: false,
      pauseWhenUnfocused: false,
      useVideoAudio: false,
    },
    ...overrides,
  };
}

describe("WallpaperPreview", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the selected image with the current visual settings", () => {
    render(
      <WallpaperPreview
        wallpaper={wallpaper({
          fit: "contain",
          opacity: 0.6,
          blur: 8,
          dim: 0.45,
          terminalOpacity: 0.4,
          glassBlur: 6,
        })}
        assetUrl="asset://wallpaper.png"
        label="Preview"
      />,
    );

    expect(screen.getByTestId("wallpaper-preview")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("wallpaper-preview-image")).toHaveStyle({
      backgroundImage: 'url("asset://wallpaper.png")',
      backgroundSize: "contain",
      opacity: "0.6",
    });
    expect(screen.getByTestId("wallpaper-preview-media-frame")).toHaveStyle({
      filter: "blur(8px)",
      transform: "scale(1.06)",
    });
    expect(screen.getByTestId("wallpaper-preview-dim")).toHaveStyle({ opacity: "0.45" });
    expect(screen.getByTestId("wallpaper-preview-terminal")).toHaveAttribute(
      "data-terminal-opacity",
      "0.4",
    );
    expect(screen.getByTestId("wallpaper-preview-terminal")).toHaveStyle({
      backdropFilter: "blur(6px)",
    });
  });

  it("renders a video preview and applies playback settings", () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});

    render(
      <WallpaperPreview
        wallpaper={wallpaper({
          kind: "video",
          fit: "center",
          video: {
            autoplay: true,
            playbackRate: 1.5,
            pauseWhenUnfocused: false,
            powerSaver: "never",
          },
        })}
        assetUrl="asset://wallpaper.mp4"
        label="Preview"
      />,
    );

    const video = screen.getByTestId("wallpaper-preview-video") as HTMLVideoElement;
    expect(video).toHaveAttribute("src", "asset://wallpaper.mp4");
    expect(video).toHaveStyle({ objectFit: "none" });
    expect(video.playbackRate).toBe(1.5);
    expect(play).toHaveBeenCalledOnce();
  });

  it("pauses a running video when autoplay is disabled", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const current = wallpaper({
      kind: "video",
      video: {
        autoplay: true,
        playbackRate: 1,
        pauseWhenUnfocused: false,
        powerSaver: "never",
      },
    });
    const { rerender } = render(
      <WallpaperPreview wallpaper={current} assetUrl="asset://wallpaper.mp4" label="Preview" />,
    );

    rerender(
      <WallpaperPreview
        wallpaper={{ ...current, video: { ...current.video, autoplay: false } }}
        assetUrl="asset://wallpaper.mp4"
        label="Preview"
      />,
    );

    expect(pause).toHaveBeenCalled();
  });

  it("falls back to an opaque terminal preview while wallpaper is disabled", () => {
    render(
      <WallpaperPreview
        wallpaper={wallpaper({ enabled: false, terminalOpacity: 0.2 })}
        assetUrl="asset://wallpaper.png"
        label="Preview"
      />,
    );

    expect(screen.getByTestId("wallpaper-preview")).toHaveAttribute("data-active", "false");
    expect(screen.queryByTestId("wallpaper-preview-image")).not.toBeInTheDocument();
    expect(screen.getByTestId("wallpaper-preview-terminal")).toHaveAttribute(
      "data-terminal-opacity",
      "1",
    );
  });
});
