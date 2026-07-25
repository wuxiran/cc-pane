import "@/i18n";
import i18n from "i18next";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "@/types";
import { usePanesStore } from "@/stores";
import { TooltipProvider } from "@/components/ui/tooltip";
import { browserService } from "@/services/browserService";
import BrowserTabContent from "./BrowserTabContent";

let pageLoadHandler: ((event: { tabId: string; url: string; loading: boolean }) => void) | null = null;
let titleHandler: ((event: { tabId: string; title: string }) => void) | null = null;

vi.mock("@/services/browserService", () => ({
  browserService: {
    create: vi.fn().mockResolvedValue(undefined),
    setBounds: vi.fn().mockResolvedValue(undefined),
    setVisible: vi.fn().mockResolvedValue(undefined),
    navigate: vi.fn().mockResolvedValue(undefined),
    back: vi.fn().mockResolvedValue(undefined),
    forward: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(undefined),
    openDevtools: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    onPageLoad: vi.fn(async (handler) => {
      pageLoadHandler = handler;
      return () => { pageLoadHandler = null; };
    }),
    onTitleChanged: vi.fn(async (handler) => {
      titleHandler = handler;
      return () => { titleHandler = null; };
    }),
  },
}));

function makeBrowserTab(): Tab {
  return {
    id: "browser-tab-1",
    title: "Preview",
    contentType: "browser",
    projectId: "",
    projectPath: "",
    sessionId: null,
    browserUrl: "http://localhost:5173/",
  };
}

function renderBrowser(options: { isVisible?: boolean; isActive?: boolean } = {}) {
  return render(
    <TooltipProvider>
      <BrowserTabContent
        tab={makeBrowserTab()}
        isVisible={options.isVisible ?? true}
        isActive={options.isActive ?? true}
      />
    </TooltipProvider>,
  );
}

describe("BrowserTabContent", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 10,
      y: 48,
      top: 48,
      left: 10,
      right: 910,
      bottom: 648,
      width: 900,
      height: 600,
      toJSON: () => ({}),
    });
    usePanesStore.setState({ updateBrowserTab: vi.fn() } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    pageLoadHandler = null;
    titleHandler = null;
  });

  it("creates the child webview from the measured viewport and destroys it on unmount", async () => {
    const view = renderBrowser();

    await waitFor(() => expect(browserService.create).toHaveBeenCalledWith(
      "browser-tab-1",
      "http://localhost:5173/",
      { x: 10, y: 48, width: 900, height: 600 },
      true,
    ));

    view.unmount();
    expect(browserService.close).toHaveBeenCalledWith("browser-tab-1");
  });

  it("normalizes address input and exposes back, forward, refresh and devtools controls", async () => {
    const user = userEvent.setup();
    renderBrowser();
    await waitFor(() => expect(browserService.create).toHaveBeenCalled());

    const address = screen.getByRole("textbox", { name: i18n.t("browserAddress", { ns: "panes" }) });
    await user.clear(address);
    await user.type(address, "localhost:4173");
    fireEvent.keyDown(address, { key: "Enter" });

    await waitFor(() => expect(browserService.navigate).toHaveBeenCalledWith(
      "browser-tab-1",
      "http://localhost:4173/",
    ));
    await user.click(screen.getByRole("button", { name: i18n.t("browserBack", { ns: "panes" }) }));
    await user.click(screen.getByRole("button", { name: i18n.t("browserForward", { ns: "panes" }) }));
    await user.click(screen.getByRole("button", { name: i18n.t("browserReload", { ns: "panes" }) }));
    await user.click(screen.getByRole("button", { name: i18n.t("browserDevtools", { ns: "panes" }) }));

    expect(browserService.back).toHaveBeenCalledWith("browser-tab-1");
    expect(browserService.forward).toHaveBeenCalledWith("browser-tab-1");
    expect(browserService.reload).toHaveBeenCalledWith("browser-tab-1");
    expect(browserService.openDevtools).toHaveBeenCalledWith("browser-tab-1");
  });

  it("syncs page URL, loading state and title events into tab metadata", async () => {
    const updateBrowserTab = vi.fn();
    usePanesStore.setState({ updateBrowserTab } as never);
    renderBrowser();
    await waitFor(() => expect(pageLoadHandler).not.toBeNull());

    act(() => {
      pageLoadHandler?.({ tabId: "browser-tab-1", url: "https://example.com/", loading: true });
      titleHandler?.({ tabId: "browser-tab-1", title: "Example" });
    });

    expect(updateBrowserTab).toHaveBeenCalledWith("browser-tab-1", {
      browserUrl: "https://example.com/",
    });
    expect(updateBrowserTab).toHaveBeenCalledWith("browser-tab-1", { title: "Example" });
    expect(screen.getByTestId("browser-loading")).toBeInTheDocument();
  });
});
