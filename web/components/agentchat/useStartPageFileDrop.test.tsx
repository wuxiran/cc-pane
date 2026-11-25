// 启动页原生拖放：落在对话区内 → 路径交给附件摄取（chip）；区外（其他窗格）不处理；
// 同一次 drop 被多个监听重复投递、或已是附件的路径，不重复摄取。
import "@/i18n";
import { useCallback, useRef, useState } from "react";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDroppedPaths, useStartPageFileDrop } from "./useStartPageFileDrop";

vi.mock("@/services/runtime", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isTauriRuntime: () => true,
}));

type DropPayload =
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } };
const handlers: Array<(event: { payload: DropPayload }) => void> = [];
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (handler: (event: { payload: DropPayload }) => void) => {
      handlers.push(handler);
      return Promise.resolve(() => {
        const index = handlers.indexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
      });
    },
  }),
}));

function StartPage({ onPaths }: { onPaths?: (paths: string[]) => Promise<void> }) {
  const [attached, setAttached] = useState<string[]>([]);
  const attachedRef = useRef<string[]>([]);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const ingest = useCallback(async (paths: string[]) => {
    await onPaths?.(paths);
    attachedRef.current = [...attachedRef.current, ...paths];
    setAttached(attachedRef.current);
  }, [onPaths]);
  const known = useCallback(() => attachedRef.current, []);
  useStartPageFileDrop(ref, ingest, known);
  return (
    <>
      <div data-agent-chat-drop-zone="" data-testid="zone">
        <h2 data-testid="hero">hero</h2>
        <ul data-testid="chips">{attached.map((path) => <li key={path}>{path}</li>)}</ul>
        <textarea ref={ref} defaultValue="" />
      </div>
      <div data-testid="other-pane" />
    </>
  );
}

const emit = (payload: DropPayload) => act(() => handlers.forEach((handler) => handler({ payload })));
const chips = () => Array.from(screen.getByTestId("chips").querySelectorAll("li")).map((item) => item.textContent);

describe("useStartPageFileDrop", () => {
  beforeEach(() => {
    handlers.length = 0;
  });

  it("dedupes against known paths and within a batch", () => {
    expect(freshDroppedPaths([], ["/a.ts", "/b.ts"])).toEqual(["/a.ts", "/b.ts"]);
    expect(freshDroppedPaths(["/a.ts"], ["/a.ts", "/b.ts"])).toEqual(["/b.ts"]);
    expect(freshDroppedPaths([], ["/a.ts", "/a.ts", ""])).toEqual(["/a.ts"]);
  });

  it("routes paths dropped anywhere on the chat zone into attachments, not the draft text", async () => {
    render(<StartPage />);
    await vi.waitFor(() => expect(handlers.length).toBeGreaterThan(0));
    const zone = screen.getByTestId("zone");
    document.elementFromPoint = (() => screen.getByTestId("hero")) as unknown as typeof document.elementFromPoint;

    emit({ type: "over", position: { x: 1, y: 1 } });
    expect(zone).toHaveAttribute("data-chat-drop-active", "true");

    emit({ type: "drop", paths: ["/Users/me/report.md"], position: { x: 1, y: 1 } });
    expect(zone).not.toHaveAttribute("data-chat-drop-active");
    await vi.waitFor(() => expect(chips()).toEqual(["/Users/me/report.md"]));
    expect(screen.getByRole("textbox")).toHaveValue("");

    // 已是附件的路径再拖一次不重复。
    emit({ type: "drop", paths: ["/Users/me/report.md"], position: { x: 1, y: 1 } });
    await act(async () => {});
    expect(chips()).toEqual(["/Users/me/report.md"]);
  });

  it("does not ingest twice when the same drop is delivered while the first is in flight", async () => {
    let release: () => void = () => {};
    const onPaths = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    render(<StartPage onPaths={onPaths} />);
    await vi.waitFor(() => expect(handlers.length).toBeGreaterThan(0));
    document.elementFromPoint = (() => screen.getByTestId("hero")) as unknown as typeof document.elementFromPoint;

    emit({ type: "drop", paths: ["/Users/me/shot.png"], position: { x: 1, y: 1 } });
    emit({ type: "drop", paths: ["/Users/me/shot.png"], position: { x: 1, y: 1 } });
    await vi.waitFor(() => expect(onPaths).toHaveBeenCalledTimes(1));
    await act(async () => release());
    await vi.waitFor(() => expect(chips()).toEqual(["/Users/me/shot.png"]));
    expect(onPaths).toHaveBeenCalledTimes(1);
  });

  it("ignores drops that land on another pane", async () => {
    const onPaths = vi.fn(async () => {});
    render(<StartPage onPaths={onPaths} />);
    await vi.waitFor(() => expect(handlers.length).toBeGreaterThan(0));
    document.elementFromPoint = (() => screen.getByTestId("other-pane")) as unknown as typeof document.elementFromPoint;
    emit({ type: "drop", paths: ["/Users/me/report.md"], position: { x: 1, y: 1 } });
    await act(async () => {});
    expect(onPaths).not.toHaveBeenCalled();
    expect(chips()).toEqual([]);
  });
});
