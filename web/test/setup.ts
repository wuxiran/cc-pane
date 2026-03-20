import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

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
}));

vi.mock("@tauri-apps/api/webview", () => {
  const webview = {
    listen: vi.fn(() => Promise.resolve(() => {})),
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
