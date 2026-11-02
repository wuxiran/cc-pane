import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { captureAnnotationFrame, saveBrowserAnnotation } from "@/services/browserAnnotationService";
import { useBrowserWebviewOverlayStore } from "@/stores/useBrowserWebviewOverlayStore";
import type { AnnotationFrame } from "./annotationModel";
import { useAnnotationDocument } from "./useAnnotationDocument";

vi.mock("@/services/browserAnnotationService", () => ({ captureAnnotationFrame: vi.fn(), saveBrowserAnnotation: vi.fn() }));
const frame = (title: string): AnnotationFrame => ({ dataUrl: "data:image/png;base64,AA==", sourcePath: `/tmp/${title}.png`, width: 100, height: 100,
  url: `https://example.com/${title}`, title, capturedAt: "2026-10-25T00:00:00Z", viewport: { width: 100, height: 100 } });
const saved = { filePath: "/tmp/annotation.png", metadataPath: "/tmp/annotation.annotations.json", markdown: "Issue", dataUrl: "data:image/png;base64,AA==" };

beforeEach(() => {
  vi.clearAllMocks();
  useBrowserWebviewOverlayStore.setState({ blockers: new Set() });
  vi.mocked(captureAnnotationFrame).mockImplementation(async (id) => frame(id));
});

it("starts a new document while an old save is pending and ignores the old completion", async () => {
  let oldComplete!: (value: typeof saved) => void;
  let newComplete!: (value: typeof saved) => void;
  vi.mocked(saveBrowserAnnotation)
    .mockImplementationOnce(() => new Promise((resolve) => { oldComplete = resolve; }))
    .mockImplementationOnce(() => new Promise((resolve) => { newComplete = resolve; }));
  const oldHandoff = vi.fn(async () => {});
  const { result, rerender, unmount } = renderHook(({ id }) => useAnnotationDocument(id), { initialProps: { id: "old" } });
  await waitFor(() => expect(result.current.frame?.title).toBe("old"));
  let first!: Promise<void>;
  act(() => { first = result.current.perform(oldHandoff, "Old success"); });
  expect(result.current.busy).toBe(true);
  rerender({ id: "new" });
  await waitFor(() => expect(result.current.frame?.title).toBe("new"));
  expect(result.current.busy).toBe(false);
  let second!: Promise<void>;
  act(() => { second = result.current.perform(undefined, "New success"); });
  await act(async () => { oldComplete(saved); await first; });
  expect(oldHandoff).not.toHaveBeenCalled();
  expect(result.current.busy).toBe(true);
  expect(result.current.saved).toBeNull();
  await act(async () => { newComplete(saved); await second; });
  expect(result.current.notice).toBe("New success");
  expect(result.current.busy).toBe(false);
  unmount();
  expect(useBrowserWebviewOverlayStore.getState().blockers.size).toBe(0);
});

it("reports an export or draft-handoff failure without a success notice", async () => {
  vi.mocked(saveBrowserAnnotation).mockResolvedValueOnce(saved);
  const { result } = renderHook(() => useAnnotationDocument("tab"));
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => { await result.current.perform(async () => { throw new Error("Attachment read failed"); }, "Added to draft"); });
  expect(result.current.error).toContain("Attachment read failed");
  expect(result.current.notice).toBeNull();
  expect(result.current.busy).toBe(false);
  expect(result.current.saved?.filePath).toBe(saved.filePath);
});
