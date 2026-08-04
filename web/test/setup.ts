import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

if (typeof window !== "undefined") {
  window.__TAURI_INTERNALS__ = {};

  // Node 25 may expose an incomplete global localStorage object in jsdom.
  if (typeof window.localStorage?.getItem !== "function") {
    const values = new Map<string, string>();
    const clear = () => values.clear();
    const getItem = (key: string) => values.get(key) ?? null;
    const key = (index: number) => Array.from(values.keys())[index] ?? null;
    const removeItem = (item: string) => values.delete(item);
    const setItem = (item: string, value: string) => values.set(item, String(value));
    const storagePrototype = window.Storage?.prototype;
    if (storagePrototype) {
      Object.defineProperties(storagePrototype, {
        clear: { configurable: true, value: clear },
        getItem: { configurable: true, value: getItem },
        key: { configurable: true, value: key },
        length: { configurable: true, get: () => values.size },
        removeItem: { configurable: true, value: removeItem },
        setItem: { configurable: true, value: setItem },
      });
    }
    const storage = storagePrototype
      ? (Object.create(storagePrototype) as Storage)
      : ({ clear, getItem, key, length: 0, removeItem, setItem } as unknown as Storage);
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: storage,
    });
  }
  if (typeof globalThis.localStorage?.getItem !== "function") {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: window.localStorage,
    });
  }
}

// jsdom 未实现 ResizeObserver，而 Radix（Tooltip/Popover 等）在挂载时会用到。
// 用直接赋值而非 vi.stubGlobal——后者会被个别测试的 vi.unstubAllGlobals() 清除，
// 导致依赖它的组件测试在全量套件里随机崩溃（ReferenceError: ResizeObserver is not defined）。
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// 每个测试后自动清理 DOM
afterEach(() => {
  cleanup();
});

// Mock Tauri API
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(),
  emitTo: vi.fn(),
}));

vi.mock("@tauri-apps/api/webview", () => {
  const webview = {
    listen: vi.fn(() => Promise.resolve(() => {})),
    onDragDropEvent: vi.fn(() => Promise.resolve(() => {})),
  };
  return {
    getCurrentWebview: vi.fn(() => webview),
  };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
  message: vi.fn(),
  ask: vi.fn(),
  confirm: vi.fn(),
}));
