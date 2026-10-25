import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { createPanel } from "@/lib/paneTree";
import { browserService } from "@/services/browserService";
import { terminalPathLinkService } from "@/services/terminalPathLinkService";
import { usePanesStore } from "@/stores/usePanesStore";
import type { Tab } from "@/types";
import WorkbenchTabMenuItems from "./WorkbenchTabMenuItems";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/services/terminalPathLinkService", () => ({ terminalPathLinkService: { openExternalUrl: vi.fn(async () => {}) } }));

function setup(contentType: Tab["contentType"] = "browser") {
  const tab: Tab = { id: "source", contentType, title: "Source", browserUrl: "https://example.com/page", projectId: "p", projectPath: "/repo", sessionId: null };
  const panel = createPanel(tab);
  usePanesStore.setState({ rootPane: panel, activePaneId: panel.id, currentLayoutId: "test", layouts: [{ id: "test", name: "Test", rootPane: panel, activePaneId: panel.id }] });
  render(<ContextMenu><ContextMenuTrigger>Tab</ContextMenuTrigger><ContextMenuContent><WorkbenchTabMenuItems tab={tab} paneId={panel.id} section="browser" /></ContextMenuContent></ContextMenu>);
  fireEvent.contextMenu(screen.getByText("Tab"));
  return { tab, panel };
}

describe("workbench tab actions", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("duplicates only a browser into a separate next tab", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole("menuitem", { name: "复制标签页" }));
    const tabs = usePanesStore.getState().allPanels()[0].tabs;
    expect(tabs).toHaveLength(2);
    expect(tabs[1]).toMatchObject({ browserUrl: "https://example.com/page", contentType: "browser", projectPath: "/repo", sessionId: null });
    expect(tabs[1].id).not.toBe("source");
  });

  it.each(["dsh", "agent-chat", "terminal", "editor"] as const)("does not duplicate %s session or editor state", (type) => {
    setup(type);
    expect(screen.queryByRole("menuitem", { name: "复制标签页" })).not.toBeInTheDocument();
  });

  it("dispatches reload and reports the native failure", async () => {
    const user = userEvent.setup();
    vi.spyOn(browserService, "reload").mockRejectedValueOnce(new Error("Webview unavailable"));
    setup("dsh");
    await user.click(await screen.findByRole("menuitem", { name: "重新加载" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Webview unavailable")));
    expect(browserService.reload).toHaveBeenCalledWith("source");
  });

  it("reports clipboard denial without an unhandled rejection", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("Clipboard denied"));
    setup();
    await user.click(await screen.findByRole("menuitem", { name: "复制 URL" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Clipboard denied")));
  });

  it("asks the native browser to move and reports failure without changing the tab", async () => {
    const user = userEvent.setup();
    vi.spyOn(browserService, "popOut").mockRejectedValueOnce(new Error("Window unavailable"));
    setup();
    await user.click(await screen.findByRole("menuitem", { name: "移至新窗口" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Window unavailable")));
    expect(browserService.popOut).toHaveBeenCalledExactlyOnceWith("source");
    expect(usePanesStore.getState().allPanels()[0].tabs.map((tab) => tab.id)).toEqual(["source"]);
  });

  it("opens only the selected browser URL externally", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole("menuitem", { name: "在外部浏览器中打开" }));
    await waitFor(() => expect(terminalPathLinkService.openExternalUrl).toHaveBeenCalledExactlyOnceWith("https://example.com/page"));
  });
});
