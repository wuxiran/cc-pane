import i18n from "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OrchestratorTaskActions from "./OrchestratorTaskActions";
import {
  useActivityBarStore,
  useOrchestratorStore,
  useTerminalStatusStore,
} from "@/stores";
import type { TaskBinding, TerminalStatusInfo } from "@/types";

const tt = (k: string, opts?: Record<string, unknown>) =>
  String(i18n.t(k as never, opts as never));
const tRe = (k: string) => new RegExp(tt(k));

const killIdempotent = vi.fn(async (..._a: unknown[]) => undefined);
const createSession = vi.fn(async (..._a: unknown[]) => "session-new");
const submitToSession = vi.fn(async (..._a: unknown[]) => undefined);
const getCurrentBranch = vi.fn(async (..._a: unknown[]) => "main");

vi.mock("@/services", () => ({
  localHistoryService: { getCurrentBranch: (...a: unknown[]) => getCurrentBranch(...a) },
  terminalService: {
    killIdempotent: (...a: unknown[]) => killIdempotent(...a),
    createSession: (...a: unknown[]) => createSession(...a),
    submitToSession: (...a: unknown[]) => submitToSession(...a),
  },
  taskBindingService: {
    query: vi.fn(async () => ({ items: [], total: 0, hasMore: false })),
  },
}));

let idCounter = 0;
function createBinding(overrides: Partial<TaskBinding> = {}): TaskBinding {
  idCounter += 1;
  const now = new Date().toISOString();
  return {
    id: `bind-${idCounter}`,
    title: `Task ${idCounter}`,
    role: "task",
    projectPath: "/repo/frontend",
    cliTool: "claude",
    status: "running",
    progress: 40,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const create = vi.fn(async (r: unknown) => ({ ...(r as object), id: "new-id" }));
const remove = vi.fn(async () => undefined);
const removeCascade = vi.fn(async () => undefined);
const update = vi.fn(async () => ({}));
const updatePatch = vi.fn(async () => ({}));
const setSelectedTaskId = vi.fn();

function seedStore(bindings: TaskBinding[]) {
  useOrchestratorStore.setState({
    bindings,
    create: create as never,
    remove: remove as never,
    removeCascade: removeCascade as never,
    update: update as never,
    updatePatch: updatePatch as never,
    setSelectedTaskId: setSelectedTaskId as never,
  });
}

function setSessionStatus(sessionId: string, status: TerminalStatusInfo["status"]) {
  useTerminalStatusStore.setState({
    statusMap: new Map<string, TerminalStatusInfo>([
      [sessionId, { sessionId, status, lastOutputAt: 0, updatedAt: Date.now() }],
    ]),
  });
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTitle(tt("orchestration:sidebar.actions")));
}

describe("OrchestratorTaskActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedStore([]);
    useTerminalStatusStore.setState({ statusMap: new Map() });
    useActivityBarStore.setState({ orchestrationOverlayOpen: false });
  });

  it("opens the action menu with all entries", async () => {
    const user = userEvent.setup();
    const binding = createBinding();
    seedStore([binding]);
    render(<OrchestratorTaskActions binding={binding} />);

    await openMenu(user);

    expect(await screen.findByRole("menuitem", { name: tRe("orchestration:sidebar.details") })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: tRe("orchestration:sidebar.kill") })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: tRe("orchestration:sidebar.retry") })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: tRe("orchestration:sidebar.edit") })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: tRe("orchestration:sidebar.sendMessage") })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: tRe("orchestration:sidebar.mute") })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: tRe("orchestration:sidebar.delete") })).toBeVisible();
  });

  it("opens task details and the orchestration overlay", async () => {
    const user = userEvent.setup();
    const binding = createBinding();
    seedStore([binding]);
    render(<OrchestratorTaskActions binding={binding} />);

    await openMenu(user);
    await user.click(await screen.findByRole("menuitem", { name: tRe("orchestration:sidebar.details") }));

    expect(setSelectedTaskId).toHaveBeenCalledWith(binding.id);
    expect(useActivityBarStore.getState().orchestrationOverlayOpen).toBe(true);
  });

  it("disables Kill when the task has no session", async () => {
    const user = userEvent.setup();
    const binding = createBinding({ status: "running", sessionId: undefined });
    seedStore([binding]);
    render(<OrchestratorTaskActions binding={binding} />);

    await openMenu(user);
    expect(await screen.findByRole("menuitem", { name: tRe("orchestration:sidebar.kill") })).toHaveAttribute("data-disabled");
  });

  it("kills a running session and marks the task failed", async () => {
    const user = userEvent.setup();
    const binding = createBinding({ status: "running", sessionId: "sess-1", progress: 60 });
    seedStore([binding]);
    render(<OrchestratorTaskActions binding={binding} />);

    await openMenu(user);
    await user.click(await screen.findByRole("menuitem", { name: tRe("orchestration:sidebar.kill") }));

    await waitFor(() => expect(killIdempotent).toHaveBeenCalledWith("sess-1"));
    expect(updatePatch).toHaveBeenCalledWith(
      binding.id,
      expect.objectContaining({ status: "failed", completionSummary: "Killed by user" }),
    );
  });

  it("enables Retry only for failed tasks", async () => {
    const user = userEvent.setup();
    const running = createBinding({ status: "running", sessionId: "s" });
    seedStore([running]);
    const { unmount } = render(<OrchestratorTaskActions binding={running} />);

    await openMenu(user);
    expect(await screen.findByRole("menuitem", { name: tRe("orchestration:sidebar.retry") })).toHaveAttribute("data-disabled");
    unmount();

    const failed = createBinding({ status: "failed" });
    seedStore([failed]);
    render(<OrchestratorTaskActions binding={failed} />);
    await openMenu(user);
    expect(await screen.findByRole("menuitem", { name: tRe("orchestration:sidebar.retry") })).not.toHaveAttribute("data-disabled");
  });

  it("edits the task title and prompt", async () => {
    const user = userEvent.setup();
    const binding = createBinding({ status: "completed", title: "Old", prompt: "old prompt" });
    seedStore([binding]);
    render(<OrchestratorTaskActions binding={binding} />);

    await openMenu(user);
    await user.click(await screen.findByRole("menuitem", { name: tRe("orchestration:sidebar.edit") }));

    const titleInput = await screen.findByDisplayValue("Old");
    await user.clear(titleInput);
    await user.type(titleInput, "New title");
    await user.click(screen.getByRole("button", { name: tt("common:save") }));

    await waitFor(() =>
      expect(updatePatch).toHaveBeenCalledWith(
        binding.id,
        expect.objectContaining({ title: "New title", prompt: "old prompt" }),
      ),
    );
  });

  it("deletes a leaf task directly without a confirmation dialog", async () => {
    const user = userEvent.setup();
    const binding = createBinding({ status: "completed" });
    seedStore([binding]);
    render(<OrchestratorTaskActions binding={binding} />);

    await openMenu(user);
    await user.click(await screen.findByRole("menuitem", { name: tRe("orchestration:sidebar.delete") }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith(binding.id));
    expect(removeCascade).not.toHaveBeenCalled();
  });

  it("confirms cascade deletion when the task has descendants", async () => {
    const user = userEvent.setup();
    const leader = createBinding({ status: "completed", role: "leader" });
    const worker = createBinding({ role: "worker", parentId: leader.id, title: "child worker" });
    seedStore([leader, worker]);
    render(<OrchestratorTaskActions binding={leader} />);

    await openMenu(user);
    await user.click(await screen.findByRole("menuitem", { name: tRe("orchestration:sidebar.delete") }));

    // A confirmation dialog listing descendants appears.
    expect(await screen.findByText(tRe("orchestration:sidebar.deleteCascadeTitle"))).toBeVisible();
    expect(screen.getByText("child worker")).toBeVisible();
    await user.click(screen.getByRole("button", { name: tt("common:delete") }));

    await waitFor(() => expect(removeCascade).toHaveBeenCalledWith(leader.id));
    expect(remove).not.toHaveBeenCalled();
  });

  it("mutes the task via metadata patch", async () => {
    const user = userEvent.setup();
    const binding = createBinding();
    seedStore([binding]);
    render(<OrchestratorTaskActions binding={binding} />);

    await openMenu(user);
    await user.click(await screen.findByRole("menuitem", { name: tRe("orchestration:sidebar.mute") }));

    await waitFor(() =>
      expect(updatePatch).toHaveBeenCalledWith(
        binding.id,
        expect.objectContaining({ metadata: { ui: { muted: true } } }),
      ),
    );
  });

  it("disables Mute when the task is already muted", async () => {
    const user = userEvent.setup();
    const binding = createBinding({ metadata: { ui: { muted: true } } });
    seedStore([binding]);
    render(<OrchestratorTaskActions binding={binding} />);

    await openMenu(user);
    expect(await screen.findByRole("menuitem", { name: tRe("orchestration:sidebar.mute") })).toHaveAttribute("data-disabled");
  });

  it("disables Send message unless the session is idle or waiting for input", async () => {
    const user = userEvent.setup();
    const binding = createBinding({ status: "running", sessionId: "sess-2" });
    seedStore([binding]);
    setSessionStatus("sess-2", "thinking");
    render(<OrchestratorTaskActions binding={binding} />);

    await openMenu(user);
    expect(await screen.findByRole("menuitem", { name: tRe("orchestration:sidebar.sendMessage") })).toHaveAttribute("data-disabled");
  });

  it("sends a message to an idle session", async () => {
    const user = userEvent.setup();
    const binding = createBinding({ status: "running", sessionId: "sess-3" });
    seedStore([binding]);
    setSessionStatus("sess-3", "idle");
    render(<OrchestratorTaskActions binding={binding} />);

    await openMenu(user);
    await user.click(await screen.findByRole("menuitem", { name: tRe("orchestration:sidebar.sendMessage") }));

    const box = await screen.findByPlaceholderText(
      new RegExp(tt("orchestration:sidebar.messageTo", { name: "frontend" })),
    );
    await user.type(box, "please continue");
    await user.click(screen.getByRole("button", { name: tt("orchestration:sidebar.send") }));

    await waitFor(() => expect(submitToSession).toHaveBeenCalledWith("sess-3", "please continue"));
  });
});
