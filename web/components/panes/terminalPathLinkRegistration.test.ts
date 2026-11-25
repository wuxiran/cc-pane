import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import { toast } from "@/components/ui/toast";
import { terminalPathLinkService } from "@/services/terminalPathLinkService";
import { useTerminalPathLinkStore } from "@/stores/useTerminalPathLinkStore";
import {
  createTerminalPathLinkIntegration,
  createTerminalPathLinkValidator,
  TERMINAL_PATH_LINK_ERROR_TOAST_ID,
} from "./terminalPathLinkRegistration";

vi.mock("@/components/ui/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/services/terminalPathLinkService", () => ({
  terminalPathLinkService: {
    resolve: vi.fn(),
    runDesktopAction: vi.fn(),
    openExternalUrl: vi.fn().mockResolvedValue(undefined),
  },
}));

const resolve = vi.mocked(terminalPathLinkService.resolve);
const translate = ((key: string) => key) as unknown as TFunction<"panes">;
const RESOLVED = {
  canonicalPath: "/Users/dev/Desktop/out.zip",
  kind: "file" as const,
  runtimeKind: "local" as const,
  outsideProjectRoot: true,
};

function unavailable() {
  return Object.assign(new Error("The terminal path is unavailable"), { code: "TERMINAL_PATH_UNAVAILABLE" });
}

describe("createTerminalPathLinkValidator", () => {
  beforeEach(() => {
    resolve.mockReset();
  });

  it("passes ~/ and relative paths to the backend verbatim (expansion and cwd resolution live there)", async () => {
    resolve.mockResolvedValue(RESOLVED);
    const validate = createTerminalPathLinkValidator(() => "session-1");

    await expect(validate({ text: "~/Desktop/out.zip", path: "~/Desktop/out.zip" })).resolves.toBe(true);
    await expect(validate({ text: "./docs/a.md", path: "./docs/a.md" })).resolves.toBe(true);

    expect(resolve).toHaveBeenCalledWith({ sessionId: "session-1", rawPath: "~/Desktop/out.zip" });
    expect(resolve).toHaveBeenCalledWith({ sessionId: "session-1", rawPath: "./docs/a.md" });
  });

  it("rejects unresolvable paths and paths without a live session", async () => {
    resolve.mockRejectedValue(unavailable());
    const validate = createTerminalPathLinkValidator(() => "session-1");
    await expect(validate({ text: "~/.claude/skills/", path: "~/.claude/skills/" })).resolves.toBe(false);

    const detached = createTerminalPathLinkValidator(() => null);
    await expect(detached({ text: "src/a.ts", path: "src/a.ts" })).resolves.toBe(false);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("caches verdicts briefly per session and path", async () => {
    resolve.mockResolvedValue(RESOLVED);
    let now = 1_000;
    const validate = createTerminalPathLinkValidator(() => "session-1", () => now);
    const reference = { text: "src/a.ts", path: "src/a.ts" };

    await validate(reference);
    await validate(reference);
    expect(resolve).toHaveBeenCalledTimes(1);

    now += 10_000;
    await validate(reference);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("treats a hung backend as not a link", async () => {
    vi.useFakeTimers();
    try {
      resolve.mockReturnValue(new Promise(() => {}));
      const validate = createTerminalPathLinkValidator(() => "session-1");
      const verdict = validate({ text: "src/a.ts", path: "src/a.ts" });
      await vi.advanceTimersByTimeAsync(2_500);
      await expect(verdict).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createTerminalPathLinkIntegration activation", () => {
  beforeEach(() => {
    resolve.mockReset();
    vi.mocked(toast.error).mockReset();
    useTerminalPathLinkStore.getState().resetForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function integration(sessionId: string | null = "session-1") {
    return createTerminalPathLinkIntegration(true, () => sessionId, () => false, () => true, translate);
  }

  it("ignores repeated activation while the same path is still resolving", async () => {
    let finish: (() => void) | undefined;
    const open = vi.spyOn(useTerminalPathLinkStore.getState(), "open").mockImplementation(
      () => new Promise<void>((done) => { finish = done; }),
    );
    const { linkHandler } = integration();

    linkHandler.activate({}, "file:///tmp/proj/a.ts");
    linkHandler.activate({}, "file:///tmp/proj/a.ts");
    expect(open).toHaveBeenCalledTimes(1);

    finish?.();
    await Promise.resolve();
    await Promise.resolve();
    linkHandler.activate({}, "file:///tmp/proj/a.ts");
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("reports resolve failures under one shared toast id", async () => {
    vi.spyOn(useTerminalPathLinkStore.getState(), "open").mockRejectedValue(unavailable());
    const { linkHandler } = integration();

    linkHandler.activate({}, "file:///Desktop/a.zip");
    linkHandler.activate({}, "file:///.claude/skills");
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2));

    for (const call of vi.mocked(toast.error).mock.calls) {
      expect(call[1]).toEqual({ id: TERMINAL_PATH_LINK_ERROR_TOAST_ID });
    }
  });

  it("uses the shared toast id when the session is gone", () => {
    const { linkHandler } = integration(null);
    linkHandler.activate({}, "file:///tmp/proj/a.ts");
    expect(toast.error).toHaveBeenCalledWith("terminalPathLink.sessionUnavailable", {
      id: TERMINAL_PATH_LINK_ERROR_TOAST_ID,
    });
  });
});
