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
});
