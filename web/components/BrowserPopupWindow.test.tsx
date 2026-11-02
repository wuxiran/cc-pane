import "@/i18n";
import i18n from "i18next";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserService, type BrowserHostState } from "@/services/browserService";
import { startBrowserWindowDrag } from "@/services/browserWindowService";
import { useBrowserWebviewOverlayStore } from "@/stores/useBrowserWebviewOverlayStore";
import BrowserPopupWindow from "./BrowserPopupWindow";

const { handlers, setTitle } = vi.hoisted(() => ({ handlers: new Set<(event: BrowserHostState) => void>(), setTitle: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/runtime", async (original) => ({ ...await original<typeof import("@/services/runtime")>(), getCurrentWindowIfTauri: () => ({ setTitle }) }));
vi.mock("@/services/browserWindowService", () => ({ startBrowserWindowDrag: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/browserService", () => ({ browserService: {
  hostState: vi.fn(), onHostChanged: vi.fn(async (handler) => { handlers.add(handler); return () => handlers.delete(handler); }),
  onPageLoad: vi.fn(async () => () => {}), onTitleChanged: vi.fn(async () => () => {}),
  create: vi.fn().mockResolvedValue(undefined), setBounds: vi.fn().mockResolvedValue(undefined), setVisible: vi.fn().mockResolvedValue(undefined),
  setViewport: vi.fn().mockResolvedValue({ width: 480, height: 260, scale: 1 }),
  setWindowMode: vi.fn().mockResolvedValue({ mode: "window" }), reclaim: vi.fn().mockResolvedValue(undefined),
  navigate: vi.fn(), reload: vi.fn(), close: vi.fn(), releaseHost: vi.fn(),
} }));
const mini: BrowserHostState = { tabId: "page", hostWindow: "popup-browser-page", mode: "mini", url: "https://example.com", title: "Live preview" };
const emitHost = (state: BrowserHostState) => act(() => { for (const handler of handlers) handler(state); });

beforeEach(async () => {
  await i18n.changeLanguage("en"); vi.clearAllMocks(); handlers.clear();
  history.replaceState(null, "", "/?mode=browser-popup&tabId=page");
  useBrowserWebviewOverlayStore.setState({ blockers: new Set() });
  vi.mocked(browserService.hostState).mockResolvedValue(mini);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 40, top: 40, left: 0, right: 480, bottom: 300, width: 480, height: 260, toJSON: () => ({}) });
});
afterEach(() => { vi.restoreAllMocks(); history.replaceState(null, "", "/"); });

describe("BrowserPopupWindow mini presentation", () => {
  it("uses compact chrome and restores regular mode on the same live view", async () => {
    render(<BrowserPopupWindow />);
    await screen.findByTestId("browser-mini-toolbar");
    await waitFor(() => expect(browserService.create).toHaveBeenCalledOnce());
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore full window" }));
    expect(browserService.setWindowMode).toHaveBeenCalledExactlyOnceWith("page", "window");
    emitHost({ ...mini, mode: "window" });
    await screen.findByRole("textbox");
    expect(browserService.create).toHaveBeenCalledOnce();
    expect(browserService.navigate).not.toHaveBeenCalled();
    expect(browserService.close).not.toHaveBeenCalled();
  });

  it("closes mini presentation by reclaiming, never by destroying the page", async () => {
    const rendered = render(<BrowserPopupWindow />);
    await screen.findByTestId("browser-mini-toolbar");
    fireEvent.click(screen.getByRole("button", { name: "Close mini window and return to panel" }));
    await waitFor(() => expect(browserService.reclaim).toHaveBeenCalledExactlyOnceWith("page"));
    rendered.unmount();
    expect(browserService.close).not.toHaveBeenCalled();
    expect(browserService.releaseHost).not.toHaveBeenCalled();
  });

  it("ignores an older initial host response after receiving the mini event", async () => {
    let resolve!: (state: BrowserHostState) => void;
    vi.mocked(browserService.hostState).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    render(<BrowserPopupWindow />);
    emitHost(mini);
    await screen.findByTestId("browser-mini-toolbar");
    await act(async () => { resolve({ ...mini, mode: "window" }); });
    expect(screen.getByTestId("browser-mini-toolbar")).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("starts native window dragging only from the drag handle", async () => {
    render(<BrowserPopupWindow />);
    const drag = await screen.findByRole("button", { name: "Drag mini window" });
    const event = new Event("pointerdown", { bubbles: true });
    Object.defineProperty(event, "button", { value: 0 });
    fireEvent(drag, event);
    expect(startBrowserWindowDrag).toHaveBeenCalledOnce();
    expect(browserService.close).not.toHaveBeenCalled();
  });
});
