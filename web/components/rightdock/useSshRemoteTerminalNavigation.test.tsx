import "@/i18n";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPanel } from "@/lib/paneTree";
import { useActivityBarStore, usePanesStore } from "@/stores";
import type { CliTool, FsEntry, Tab } from "@/types";
import {
  buildRemoteCdCommand,
  useSshRemoteTerminalNavigation,
} from "./useSshRemoteTerminalNavigation";

const serviceMocks = vi.hoisted(() => ({
  submitToSession: vi.fn(async () => undefined),
}));

vi.mock("@/services", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services")>();
  return {
    ...actual,
    terminalService: {
      ...actual.terminalService,
      submitToSession: serviceMocks.submitToSession,
    },
  };
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const directory: FsEntry = {
  name: "source",
  path: "/srv/app/source",
  isDir: true,
  isFile: false,
  isSymlink: false,
  size: 0,
  modified: null,
  extension: null,
  hidden: false,
};

function seedActiveTerminal(machineId: string, cliTool: CliTool = "none") {
  const tab: Tab = {
    id: "tab-shell",
    title: "Shell",
    contentType: "terminal",
    projectId: "ssh-project",
    projectPath: "/srv/app",
    sessionId: "session-shell",
    cliTool,
    ssh: {
      host: "server.example.com",
      port: 22,
      user: "dev",
      remotePath: "/srv/app",
      machineId,
    },
  };
  const panel = createPanel(tab);
  usePanesStore.setState({ activePane: () => panel } as never);
}

async function changeDirectory(machineId = "m-1", entry = directory) {
  const { result } = renderHook(() => useSshRemoteTerminalNavigation(machineId));
  await act(async () => result.current(entry));
}

describe("useSshRemoteTerminalNavigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedActiveTerminal("m-1");
    useActivityBarStore.setState({
      appViewMode: "files",
      orchestrationOverlayOpen: true,
    });
  });

  it("submits cd to the active shell for the same SSH machine", async () => {
    await changeDirectory();

    expect(serviceMocks.submitToSession).toHaveBeenCalledWith(
      "session-shell",
      "cd '/srv/app/source'",
    );
    expect(useActivityBarStore.getState()).toMatchObject({
      appViewMode: "panes",
      orchestrationOverlayOpen: false,
    });
  });

  it("shell-escapes single quotes in remote paths", () => {
    expect(buildRemoteCdCommand("/srv/app/team's source")).toBe(
      `cd '/srv/app/team'"'"'s source'`,
    );
  });

  it.each(["claude", "codex"] satisfies CliTool[])(
    "does not submit cd to an active %s terminal",
    async (cliTool) => {
      seedActiveTerminal("m-1", cliTool);

      await changeDirectory();

      expect(serviceMocks.submitToSession).not.toHaveBeenCalled();
    },
  );

  it("does not submit cd to a terminal for another SSH machine", async () => {
    seedActiveTerminal("m-2");

    await changeDirectory();

    expect(serviceMocks.submitToSession).not.toHaveBeenCalled();
  });
});
