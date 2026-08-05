import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { error as logError } from "@tauri-apps/plugin-log";
import type { ReactElement } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import ErrorBoundary, { canReloadPage, retryAfterError } from "./ErrorBoundary";

vi.mock("@tauri-apps/plugin-log", () => ({
  error: vi.fn(() => Promise.resolve()),
}));

function CrashingChild(): ReactElement {
  throw new Error("boundary boom");
}

function DynamicImportCrashingChild(): ReactElement {
  throw new TypeError("Failed to fetch dynamically imported module: http://localhost:14200/chunk.tsx");
}

describe("ErrorBoundary", () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const logDir = "C:\\Users\\customer\\AppData\\Local\\com.ccpanes.app\\logs";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command === "get_log_dir") {
        return Promise.resolve(logDir);
      }
      if (command === "open_path_in_explorer") {
        return Promise.resolve(args);
      }
      return Promise.resolve(null);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });

  test("捕获 React 崩溃后写入日志并显示日志目录", async () => {
    render(
      <ErrorBoundary>
        <CrashingChild />
      </ErrorBoundary>,
    );

    await waitFor(() => {
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining("[frontend-crash] react-error-boundary"),
      );
    });

    expect(logError).toHaveBeenCalledWith(expect.stringContaining("boundary boom"));
    expect(await screen.findByText(logDir)).toBeInTheDocument();
    expect(screen.getByText(/最新 cc-panes\*\.log/)).toBeInTheDocument();
    expect(screen.getByText(/GitHub Issue/)).toBeInTheDocument();
    expect(screen.getByText(/github\.com\/wuxiran\/cc-pane\/issues\/new/)).toBeInTheDocument();
  });

  test("错误页可以打开日志目录", async () => {
    const user = userEvent.setup();

    render(
      <ErrorBoundary>
        <CrashingChild />
      </ErrorBoundary>,
    );

    await screen.findByText(logDir);
    await user.click(screen.getByRole("button", { name: "打开日志目录" }));

    expect(invoke).toHaveBeenCalledWith("open_path_in_explorer", { path: logDir });
  });

  test.each([
    new TypeError(
      "Failed to fetch dynamically imported module: http://localhost:14200/web/components/settings/GeneralSection.tsx",
    ),
    Object.assign(new Error("Loading chunk settings failed"), { name: "ChunkLoadError" }),
  ])("reloads the page for module loading failures", async (error) => {
    const reset = vi.fn();
    const reload = vi.fn();
    const canReload = vi.fn().mockResolvedValue(true);

    await retryAfterError(error, reset, reload, canReload);

    expect(canReload).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
    expect(reset).not.toHaveBeenCalled();
  });

  test("keeps the error page when the dev server is unavailable", async () => {
    const reset = vi.fn();
    const reload = vi.fn();
    const canReload = vi.fn().mockResolvedValue(false);

    const result = await retryAfterError(
      new TypeError("Failed to fetch dynamically imported module: http://localhost:14200/chunk.tsx"),
      reset,
      reload,
      canReload,
    );

    expect(result).toBe("unavailable");
    expect(reload).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });

  test("resets the boundary for ordinary render errors", async () => {
    const reset = vi.fn();
    const reload = vi.fn();
    const canReload = vi.fn();

    await retryAfterError(new Error("ordinary render failure"), reset, reload, canReload);

    expect(reset).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    expect(canReload).not.toHaveBeenCalled();
  });

  test("does not treat an incidental loading chunk phrase as a module failure", async () => {
    const reset = vi.fn();
    const reload = vi.fn();
    const canReload = vi.fn();

    await retryAfterError(new Error("still loading chunk of records"), reset, reload, canReload);

    expect(reset).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    expect(canReload).not.toHaveBeenCalled();
  });

  test("probes HTTP pages without cache", async () => {
    const fetchPage = vi.fn().mockResolvedValue({ ok: true });

    await expect(canReloadPage(
      { href: "http://localhost:14200/", protocol: "http:" },
      fetchPage,
    )).resolves.toBe(true);

    expect(fetchPage).toHaveBeenCalledWith(
      "http://localhost:14200/",
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );
  });

  test("skips the network probe for non-HTTP app protocols", async () => {
    const fetchPage = vi.fn();

    await expect(canReloadPage(
      { href: "tauri://localhost/", protocol: "tauri:" },
      fetchPage,
    )).resolves.toBe(true);

    expect(fetchPage).not.toHaveBeenCalled();
  });

  test("rejects a non-success page probe", async () => {
    const fetchPage = vi.fn().mockResolvedValue({ ok: false });

    await expect(canReloadPage(
      { href: "http://localhost:14200/", protocol: "http:" },
      fetchPage,
    )).resolves.toBe(false);
  });

  test("bounds an unresponsive page probe", async () => {
    const fetchPage = vi.fn((_url: string, init: RequestInit) => (
      new Promise<{ ok: boolean }>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })
    ));

    await expect(canReloadPage(
      { href: "http://localhost:14200/", protocol: "http:" },
      fetchPage,
      1,
    )).resolves.toBe(false);
  });

  test("dev server 未恢复时给出可见反馈，而不是静默无动作", async () => {
    // 事故形态：点重试 → 探测失败 → 只 console.warn → 界面纹丝不动，看着像按钮坏了。
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const user = userEvent.setup();

    render(
      <ErrorBoundary>
        <DynamicImportCrashingChild />
      </ErrorBoundary>,
    );

    await screen.findByText(logDir);
    expect(screen.queryByText(/页面源当前不可达/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByText(/页面源当前不可达/)).toBeInTheDocument();
  });

  test("disables retry until the crash log attempt finishes", async () => {
    let resolveLog!: () => void;
    vi.mocked(logError).mockReturnValueOnce(new Promise<void>((resolve) => {
      resolveLog = resolve;
    }));

    render(
      <ErrorBoundary>
        <CrashingChild />
      </ErrorBoundary>,
    );

    const retry = screen.getByRole("button", { name: "重试" });
    expect(retry).toBeDisabled();

    resolveLog();
    await waitFor(() => expect(retry).toBeEnabled());
  });

  test("disables retry while checking whether the page origin recovered", async () => {
    let resolveProbe!: (response: { ok: boolean }) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => {
      resolveProbe = resolve;
    })));
    const user = userEvent.setup();

    render(
      <ErrorBoundary>
        <DynamicImportCrashingChild />
      </ErrorBoundary>,
    );

    await screen.findByText(logDir);
    const retry = screen.getByRole("button", { name: "重试" });
    await user.click(retry);
    expect(retry).toBeDisabled();

    resolveProbe({ ok: false });
    await waitFor(() => expect(retry).toBeEnabled());
  });
});
