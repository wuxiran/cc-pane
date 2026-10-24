import { beforeEach, describe, expect, it } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { mockTauriInvoke, resetTauriInvoke } from "@/test/utils/mockTauriInvoke";
import { browserService } from "./browserService";

describe("browserService", () => {
  beforeEach(() => {
    resetTauriInvoke();
    mockTauriInvoke({
      browser_create: undefined,
      browser_set_bounds: undefined,
      browser_set_visible: undefined,
      browser_navigate: undefined,
      browser_back: undefined,
      browser_forward: undefined,
      browser_reload: undefined,
      browser_open_devtools: undefined,
      browser_close: undefined,
    });
  });

  it("creates and positions a native child webview", async () => {
    const bounds = { x: 10, y: 48, width: 900, height: 600 };

    await browserService.create("tab-1", "http://localhost:5173/", bounds, true);
    await browserService.setBounds("tab-1", bounds);
    await browserService.setVisible("tab-1", false, false);

    expect(invoke).toHaveBeenNthCalledWith(1, "browser_create", {
      tabId: "tab-1",
      url: "http://localhost:5173/",
      bounds,
      visible: true,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "browser_set_bounds", { tabId: "tab-1", bounds });
    expect(invoke).toHaveBeenNthCalledWith(3, "browser_set_visible", {
      tabId: "tab-1",
      visible: false,
      focus: false,
    });
  });

  it("maps navigation controls and close to dedicated commands", async () => {
    await browserService.navigate("tab-1", "https://example.com/");
    await browserService.back("tab-1");
    await browserService.forward("tab-1");
    await browserService.reload("tab-1");
    await browserService.openDevtools("tab-1");
    await browserService.close("tab-1");

    expect(invoke).toHaveBeenCalledWith("browser_navigate", {
      tabId: "tab-1",
      url: "https://example.com/",
    });
    expect(invoke).toHaveBeenCalledWith("browser_back", { tabId: "tab-1" });
    expect(invoke).toHaveBeenCalledWith("browser_forward", { tabId: "tab-1" });
    expect(invoke).toHaveBeenCalledWith("browser_reload", { tabId: "tab-1" });
    expect(invoke).toHaveBeenCalledWith("browser_open_devtools", { tabId: "tab-1" });
    expect(invoke).toHaveBeenCalledWith("browser_close", { tabId: "tab-1" });
  });

  it("binds Computer Use actions to an observed page and element", async () => {
    mockTauriInvoke({ browser_snapshot: { pageToken: "page-1" }, browser_list_tabs: [], browser_screenshot: "/tmp/browser.png",
      browser_fill: undefined, browser_click_element: undefined, browser_press_key: undefined, browser_scroll: undefined });
    await browserService.snapshot("tab-1");
    await browserService.listTabs();
    await expect(browserService.screenshot("tab-1")).resolves.toBe("/tmp/browser.png");
    await browserService.fill("tab-1", "page-1", 2, "a'b\n中文");
    await browserService.clickElement("tab-1", "page-1", 3);
    await browserService.pressKey("tab-1", "page-1", "Enter");
    await browserService.scroll("tab-1", "page-1", 0, 600);
    expect(invoke).toHaveBeenCalledWith("browser_fill", { tabId: "tab-1", pageToken: "page-1", elementId: 2, text: "a'b\n中文" });
    expect(invoke).toHaveBeenCalledWith("browser_click_element", { tabId: "tab-1", pageToken: "page-1", elementId: 3 });
    expect(invoke).toHaveBeenCalledWith("browser_press_key", { tabId: "tab-1", pageToken: "page-1", key: "Enter" });
    expect(invoke).toHaveBeenCalledWith("browser_scroll", { tabId: "tab-1", pageToken: "page-1", deltaX: 0, deltaY: 600 });
  });
});
