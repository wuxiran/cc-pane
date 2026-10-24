import { convertFileSrc, invoke } from "@tauri-apps/api/core";
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

export interface BrowserPageElement {
  id: number;
  tag: string;
  role: string;
  name: string;
  text: string;
  value?: string;
  disabled: boolean;
  editable: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserPageSnapshot {
  pageToken: string;
  url: string;
  title: string;
  text: string;
  elements: BrowserPageElement[];
  truncated: boolean;
  viewport: { width: number; height: number };
}

export interface BrowserTabInfo {
  tabId: string;
  url: string;
  title: string;
  visible: boolean;
}

export const browserService = {
  snapshot(tabId: string): Promise<BrowserPageSnapshot> {
    return invoke("browser_snapshot", { tabId });
  },
  listTabs(): Promise<BrowserTabInfo[]> {
    return invoke("browser_list_tabs");
  },
  screenshot(tabId: string): Promise<string> {
    return invoke("browser_screenshot", { tabId });
  },
  screenshotUrl(path: string): string {
    return convertFileSrc(path);
  },
  fill(tabId: string, pageToken: string, elementId: number, text: string): Promise<void> {
    return invoke("browser_fill", { tabId, pageToken, elementId, text });
  },
  clickElement(tabId: string, pageToken: string, elementId: number): Promise<void> {
    return invoke("browser_click_element", { tabId, pageToken, elementId });
  },
  pressKey(tabId: string, pageToken: string, key: string): Promise<void> {
    return invoke("browser_press_key", { tabId, pageToken, key });
  },
  scroll(tabId: string, pageToken: string, deltaX: number, deltaY: number): Promise<void> {
    return invoke("browser_scroll", { tabId, pageToken, deltaX, deltaY });
  },
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
