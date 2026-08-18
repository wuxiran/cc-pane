import "@/i18n";
import i18n from "i18next";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "@/types";
import { usePanesStore } from "@/stores";
import { useBrowserWebviewOverlayStore } from "@/stores/useBrowserWebviewOverlayStore";
import { TooltipProvider } from "@/components/ui/tooltip";
import { browserService } from "@/services/browserService";
import BrowserTabContent from "./BrowserTabContent";
import { useTabViewStateStore } from "@/stores/useTabViewStateStore";

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

function makeBrowserTab(browserUrl = "http://localhost:5173/"): Tab {
  return {
    id: "browser-tab-1",
    title: "Preview",
    contentType: "browser",
    projectId: "",
    projectPath: "",
    sessionId: null,
    browserUrl,
  };
}

function renderBrowser(options: { visibility?: "active" | "visible" | "hidden" } = {}) {
  // 可见性走单源：browser 组件自己按 tab.id 订阅 primary 视图
  useTabViewStateStore
    .getState()
    .reportView("browser-tab-1", "primary", options.visibility ?? "active");
  return render(
    <TooltipProvider>
      <BrowserTabContent tab={makeBrowserTab()} />
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
    useBrowserWebviewOverlayStore.setState({ blockers: new Set() });
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

  it("shows a localized prompt when the browser rejects a protocol", async () => {
    const originalLanguage = i18n.language;
    // Persistent rejection (not `Once`): if the environment ever triggers a
    // second create, a one-shot rejection would be consumed and the retry
    // would silently succeed, hiding the error overlay this test asserts on.
    vi.mocked(browserService.create).mockRejectedValue(
      new Error("unsupported browser URL scheme: file"),
    );
    try {
      // Pin the language instead of trusting the runner's ambient default —
      // CI and local machines resolve different navigator languages.
      await act(async () => {
        await i18n.changeLanguage("en");
      });
      renderBrowser();

      // Webview creation is deferred via setTimeout(0); anchor the async
      // chain on the create call before asserting on its rejection UI.
      await waitFor(() => expect(browserService.create).toHaveBeenCalled());
      expect(
        await screen.findByText(
          i18n.t("browserUnsupportedProtocol", { ns: "panes" }),
          undefined,
          { timeout: 5000 },
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText("unsupported browser URL scheme: file"))
        .not.toBeInTheDocument();

      await act(async () => {
        await i18n.changeLanguage("zh-CN");
      });
      // The re-render after a language change commits asynchronously; a
      // synchronous getByText races it.
      await waitFor(() => {
        expect(screen.getByText(i18n.t("browserUnsupportedProtocol", { ns: "panes" })))
          .toBeInTheDocument();
      });
    } finally {
      await act(async () => {
        await i18n.changeLanguage(originalLanguage);
      });
      // restoreAllMocks does not touch factory vi.fn()s — put the default
      // resolve back so the persistent rejection cannot leak into later tests.
      vi.mocked(browserService.create).mockReset();
      vi.mocked(browserService.create).mockResolvedValue(undefined);
    }
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

  it("hides the native child webview behind React overlays and restores it afterward", async () => {
    renderBrowser();
    await waitFor(() => expect(browserService.create).toHaveBeenCalled());
    vi.mocked(browserService.setVisible).mockClear();

    act(() => {
      useBrowserWebviewOverlayStore.getState().setBlocked("context-menu", true);
    });

    await waitFor(() => {
      expect(browserService.setVisible).toHaveBeenCalledWith("browser-tab-1", false, false);
    });

    act(() => {
      useBrowserWebviewOverlayStore.getState().setBlocked("context-menu", false);
    });

    await waitFor(() => {
      expect(browserService.setVisible).toHaveBeenCalledWith("browser-tab-1", true, false);
    });
  });

  // dsh 标签的 URL 是进程重启后 OS 重新分配的端口，由 DshTabContent 回填。
  // 没人会去调 navigate()（那条路只有地址栏走），所以创建 effect 必须认
  // 「URL 变了」这件事——否则 webview 永远停在上一个死端口上。
  it("re-points the existing webview when the url is replaced externally", async () => {
    useTabViewStateStore.getState().reportView("browser-tab-1", "primary", "active");
    const view = render(
      <TooltipProvider>
        <BrowserTabContent tab={makeBrowserTab("http://127.0.0.1:53157/")} />
      </TooltipProvider>,
    );

    await waitFor(() => expect(browserService.create).toHaveBeenCalledWith(
      "browser-tab-1",
      "http://127.0.0.1:53157/",
      expect.anything(),
      true,
    ));

    // dsh 实例重启，端口换了
    view.rerender(
      <TooltipProvider>
        <BrowserTabContent tab={makeBrowserTab("http://127.0.0.1:51819/")} />
      </TooltipProvider>,
    );

    await waitFor(() => expect(browserService.create).toHaveBeenCalledWith(
      "browser-tab-1",
      "http://127.0.0.1:51819/",
      expect.anything(),
      true,
    ));
  });

  // 页面自身的导航（用户点链接）会把新 URL 回填进 store。那不是「外部换 URL」，
  // 不得触发重新导航——否则用户点一下链接就被弹回原页。
  it("does not re-navigate when the page itself navigated", async () => {
    useTabViewStateStore.getState().reportView("browser-tab-1", "primary", "active");
    const view = render(
      <TooltipProvider>
        <BrowserTabContent tab={makeBrowserTab("http://localhost:5173/")} />
      </TooltipProvider>,
    );
    await waitFor(() => expect(browserService.create).toHaveBeenCalledTimes(1));

    act(() => {
      pageLoadHandler?.({
        tabId: "browser-tab-1",
        url: "http://localhost:5173/docs",
        loading: false,
      });
    });
    view.rerender(
      <TooltipProvider>
        <BrowserTabContent tab={makeBrowserTab("http://localhost:5173/docs")} />
      </TooltipProvider>,
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(browserService.create).toHaveBeenCalledTimes(1);
  });
});
