import { invoke } from "@tauri-apps/api/core";
import { listenWebviewIfTauri } from "./runtime";

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserPageLoadEvent {
  tabId: string;
  url: string;
  loading: boolean;
}

export interface BrowserTitleChangedEvent {
  tabId: string;
  title: string;
}

export const browserService = {
  create(tabId: string, url: string, bounds: BrowserBounds, visible: boolean): Promise<void> {
    return invoke("browser_create", { tabId, url, bounds, visible });
  },

  setBounds(tabId: string, bounds: BrowserBounds): Promise<void> {
    return invoke("browser_set_bounds", { tabId, bounds });
  },

  setVisible(tabId: string, visible: boolean, focus: boolean): Promise<void> {
    return invoke("browser_set_visible", { tabId, visible, focus });
  },

  navigate(tabId: string, url: string): Promise<void> {
    return invoke("browser_navigate", { tabId, url });
  },

  back(tabId: string): Promise<void> {
    return invoke("browser_back", { tabId });
  },

  forward(tabId: string): Promise<void> {
    return invoke("browser_forward", { tabId });
  },

  reload(tabId: string): Promise<void> {
    return invoke("browser_reload", { tabId });
  },

  openDevtools(tabId: string): Promise<void> {
    return invoke("browser_open_devtools", { tabId });
  },

  close(tabId: string): Promise<void> {
    return invoke("browser_close", { tabId });
  },

  onPageLoad(handler: (event: BrowserPageLoadEvent) => void | Promise<void>) {
    return listenWebviewIfTauri<BrowserPageLoadEvent>("browser-page-load", (event) => {
      return handler(event.payload);
    });
  },

  onTitleChanged(handler: (event: BrowserTitleChangedEvent) => void | Promise<void>) {
    return listenWebviewIfTauri<BrowserTitleChangedEvent>("browser-title-changed", (event) => {
      return handler(event.payload);
    });
  },
};
