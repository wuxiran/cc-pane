import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminalPathLinkService } from "@/services/terminalPathLinkService";
import type { ResolvedTerminalPathLink } from "@/services/terminalPathLinkService";
import { useTerminalPathLinkStore } from "./useTerminalPathLinkStore";

vi.mock("@/services/terminalPathLinkService", () => ({
  terminalPathLinkService: { resolve: vi.fn(), runDesktopAction: vi.fn() },
}));

const resolved: ResolvedTerminalPathLink = {
  canonicalPath: "C:/repo/src/App.tsx",
  kind: "file",
  runtimeKind: "local",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe("useTerminalPathLinkStore", () => {
  beforeEach(() => {
    useTerminalPathLinkStore.getState().resetForTest();
    vi.mocked(terminalPathLinkService.resolve).mockReset();
    vi.useRealTimers();
  });

  afterEach(() => vi.useRealTimers());

  it("opens synchronously in resolving state and transitions to ready", async () => {
    vi.mocked(terminalPathLinkService.resolve).mockResolvedValue(resolved);

    const opening = useTerminalPathLinkStore.getState().open(
      { text: "src/App.tsx:12:8", path: "src/App.tsx", line: 12, column: 8 },
      "s1",
    );
    expect(useTerminalPathLinkStore.getState().dialog.phase).toBe("resolving");

    await opening;
    expect(useTerminalPathLinkStore.getState().dialog).toMatchObject({
      phase: "ready",
      canonicalPath: resolved.canonicalPath,
      line: 12,
      column: 8,
    });
  });

  it("ignores stale resolve results and close-after-click results", async () => {
    const first = deferred<typeof resolved>();
    const second = deferred<typeof resolved>();
    vi.mocked(terminalPathLinkService.resolve)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const firstOpen = useTerminalPathLinkStore.getState().open({ text: "src/a.ts", path: "src/a.ts" }, "s1");
    const secondOpen = useTerminalPathLinkStore.getState().open({ text: "src/b.ts", path: "src/b.ts" }, "s1");
    first.resolve({ ...resolved, canonicalPath: "C:/repo/src/a.ts" });
    await firstOpen;
    expect(useTerminalPathLinkStore.getState().dialog).toMatchObject({ rawPath: "src/b.ts" });

    useTerminalPathLinkStore.getState().close();
    second.resolve({ ...resolved, canonicalPath: "C:/repo/src/b.ts" });
    await secondOpen;
    expect(useTerminalPathLinkStore.getState().dialog.phase).toBe("closed");
  });

  it("prevents action reentry and restores ready state after failure", async () => {
    vi.mocked(terminalPathLinkService.resolve).mockResolvedValue(resolved);
    await useTerminalPathLinkStore.getState().open({ text: "src/App.tsx", path: "src/App.tsx" }, "s1");
    const action = deferred<void>();

    const first = useTerminalPathLinkStore.getState().runAction("copy", () => action.promise, false);
    await expect(useTerminalPathLinkStore.getState().runAction("copy", vi.fn())).resolves.toBe(false);
    action.reject(new Error("clipboard denied"));
    await expect(first).rejects.toThrow("clipboard denied");
    expect(useTerminalPathLinkStore.getState().dialog.phase).toBe("ready");
  });

  it("closes a current resolve that exceeds the timeout", async () => {
    vi.useFakeTimers();
    vi.mocked(terminalPathLinkService.resolve).mockReturnValue(new Promise(() => {}));

    const opening = useTerminalPathLinkStore.getState().open({ text: "src/App.tsx", path: "src/App.tsx" }, "s1");
    const assertion = expect(opening).rejects.toMatchObject({ code: "TERMINAL_PATH_RESOLVE_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(useTerminalPathLinkStore.getState().dialog.phase).toBe("closed");
  });

  it("restores ready state when an action exceeds the timeout", async () => {
    vi.useFakeTimers();
    vi.mocked(terminalPathLinkService.resolve).mockResolvedValue(resolved);
    await useTerminalPathLinkStore.getState().open({ text: "src/App.tsx", path: "src/App.tsx" }, "s1");
    const action = deferred<void>();
    const running = useTerminalPathLinkStore.getState().runAction("copy", () => action.promise, false);
    const assertion = expect(running).rejects.toMatchObject({ code: "TERMINAL_PATH_ACTION_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(useTerminalPathLinkStore.getState().dialog.phase).toBe("ready");
    action.resolve();
  });

  it("ignores a late action result after the dialog closes", async () => {
    vi.mocked(terminalPathLinkService.resolve).mockResolvedValue(resolved);
    await useTerminalPathLinkStore.getState().open({ text: "src/App.tsx", path: "src/App.tsx" }, "s1");
    const action = deferred<void>();
    const running = useTerminalPathLinkStore.getState().runAction("copy", () => action.promise);
    useTerminalPathLinkStore.getState().close();
    action.resolve();
    await expect(running).resolves.toBe(true);
    expect(useTerminalPathLinkStore.getState().dialog.phase).toBe("closed");
  });
});
