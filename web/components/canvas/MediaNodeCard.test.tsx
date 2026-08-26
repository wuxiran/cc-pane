import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanvasNodeProjection } from "@/types/canvas";
import MediaNodeCard from "./MediaNodeCard";

const imageNode = (previewUrl: string): CanvasNodeProjection => ({
  id: "media:preview",
  label: "Preview",
  kind: "media",
  status: "completed",
  media: {
    mediaKind: "image",
    runStatus: "succeeded",
    previewUrl,
    assetId: previewUrl,
  },
});

const videoNode = (previewUrl: string): CanvasNodeProjection => ({
  id: "media:video",
  label: "Video",
  kind: "media",
  status: "completed",
  media: {
    mediaKind: "video",
    runStatus: "succeeded",
    previewUrl,
  },
});

describe("MediaNodeCard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries a preview when a refreshed run supplies a new asset URL", () => {
    const { rerender } = render(<MediaNodeCard node={imageNode("asset://media/old.png")} />);
    const oldImage = screen.getByTestId("canvas-media-image-media:preview");
    fireEvent.error(oldImage);
    expect(screen.getByTestId("canvas-media-empty-media:preview")).toBeInTheDocument();

    rerender(<MediaNodeCard node={imageNode("asset://media/new.png")} />);

    expect(screen.getByTestId("canvas-media-image-media:preview")).toHaveAttribute("src", "asset://media/new.png");
  });

  it("renders video previews with native controls and metadata preload", () => {
    render(<MediaNodeCard node={videoNode("/api/media/assets/video/content")} />);
    const video = screen.getByTestId("canvas-media-video-media:video");
    expect(video).toHaveAttribute("src", "/api/media/assets/video/content");
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveAttribute("preload", "metadata");
    expect(video).toHaveAttribute("playsinline");
  });

  it("releases the media source while the node is outside the Canvas scroll viewport", async () => {
    type Entry = { isIntersecting: boolean };
    class Observer {
      static latest: Observer | undefined;
      callback: (entries: Entry[]) => void;
      constructor(callback: (entries: Entry[]) => void) {
        this.callback = callback;
        Observer.latest = this;
      }
      observe() {}
      disconnect() {}
      trigger(isIntersecting: boolean) {
        this.callback([{ isIntersecting }]);
      }
    }
    vi.stubGlobal("IntersectionObserver", Observer);

    render(
      <div data-canvas-scroll-root>
        <MediaNodeCard node={videoNode("/api/media/assets/video/content")} />
      </div>,
    );
    const observer = Observer.latest;
    expect(observer).toBeDefined();
    act(() => observer?.trigger(false));
    await waitFor(() => {
      expect(screen.getByTestId("canvas-media-video-media:video")).not.toHaveAttribute("src");
      expect(screen.getByTestId("canvas-media-offscreen-media:video")).toBeInTheDocument();
    });

    act(() => observer?.trigger(true));
    await waitFor(() => expect(screen.getByTestId("canvas-media-video-media:video")).toHaveAttribute("src", "/api/media/assets/video/content"));
  });
});
