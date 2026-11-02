import { beforeEach, expect, it } from "vitest";
import { createPanel } from "@/lib/paneTree";
import { usePanesStore } from "./usePanesStore";

beforeEach(() => {
  const panel = createPanel();
  usePanesStore.setState({ rootPane: panel, activePaneId: panel.id, currentLayoutId: "test",
    layouts: [{ id: "test", name: "Test", rootPane: panel, activePaneId: panel.id }], closedTabs: [] });
});

const tabs = () => usePanesStore.getState().allPanels()[0].tabs;

it("inserts a duplicate immediately after its source with a new identity and project context", () => {
  const store = usePanesStore.getState();
  const paneId = store.activePaneId;
  store.openBrowser("https://example.com", "Original", "source", { projectPath: "/repo" });
  store.openBrowser("https://other.test", "Other", "last");
  const id = store.openBrowser("https://example.com", "Copy", undefined, {
    paneId, reuse: false, insertAfterTabId: "source", projectPath: "/repo",
  });
  expect(id).not.toBe("source");
  expect(tabs().slice(-3).map((tab) => tab.id)).toEqual(["source", id, "last"]);
  expect(tabs().find((tab) => tab.id === id)).toMatchObject({ contentType: "browser", sessionId: null, projectPath: "/repo" });
});

it("keeps a manual name through page navigation, close/reopen, and title changes", () => {
  const store = usePanesStore.getState();
  const paneId = store.activePaneId;
  store.openBrowser("https://example.com", "Page", "browser");
  store.renameTab(paneId, "browser", "My label");
  store.updateBrowserTab("browser", { title: "New page", faviconUrl: "/icon.png" });
  expect(tabs().find((tab) => tab.id === "browser")).toMatchObject({ title: "My label", browserPageTitle: "New page" });
  store.removeTabsInternal(["browser"], "user-close");
  store.reopenClosedTab(paneId);
  const restored = tabs().find((tab) => tab.contentType === "browser")!;
  expect(restored).toMatchObject({ title: "My label", browserManualTitle: "My label", browserPageTitle: "New page", browserFaviconUrl: "https://example.com/icon.png" });
  store.updateBrowserTab(restored.id, { title: "Latest page" });
  expect(tabs().find((tab) => tab.id === restored.id)?.title).toBe("My label");
  store.updateBrowserTab(restored.id, { manualTitle: null });
  expect(tabs().find((tab) => tab.id === restored.id)?.title).toBe("Latest page");
});

it("clears stale favicons on navigation and rejects arbitrary chrome image sources", () => {
  const store = usePanesStore.getState();
  store.openBrowser("https://example.com", "Page", "browser");
  store.updateBrowserTab("browser", { faviconUrl: "file:///private/secret.png" });
  expect(tabs().find((tab) => tab.id === "browser")?.browserFaviconUrl).toBeUndefined();
  store.updateBrowserTab("browser", { faviconUrl: "/icon.png" });
  store.updateBrowserTab("browser", { browserUrl: "https://other.test" });
  expect(tabs().find((tab) => tab.id === "browser")?.browserFaviconUrl).toBeUndefined();
});
