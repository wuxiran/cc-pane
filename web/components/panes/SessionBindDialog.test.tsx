import "@/i18n";
import i18n from "i18next";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "@/types";
import { usePanesStore } from "@/stores";
import { claudeService, codexService, historyService } from "@/services";
import SessionBindDialog from "./SessionBindDialog";

vi.mock("@/services/claudeService", () => ({
  claudeService: { listSessions: vi.fn() },
}));
vi.mock("@/services/codexService", () => ({
  codexService: { listSessions: vi.fn() },
}));
vi.mock("@/services/historyService", () => ({
  historyService: {
    touchBySessionId: vi.fn(),
    updateResumeSource: vi.fn(),
  },
}));

// Radix Dialog 在 jsdom 缺 ResizeObserver 时需要补桩
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

const listClaudeSessions = vi.mocked(claudeService.listSessions);
const listCodexSessions = vi.mocked(codexService.listSessions);
const touchBySessionId = vi.mocked(historyService.touchBySessionId);
const updateResumeSource = vi.mocked(historyService.updateResumeSource);

const VALID_UUID = "123e4567-e89b-42d3-a456-426614174000";

function makeTab(overrides?: Partial<Tab>): Tab {
  return {
    id: "tab-1",
    title: "Tab",
    contentType: "terminal",
    projectId: "proj-1",
    projectPath: "/tmp/proj",
    sessionId: null,
    ...overrides,
  } as Tab;
}

function renderDialog(tabOverrides?: Partial<Tab>, onOpenChange = vi.fn()) {
  render(<SessionBindDialog tab={makeTab(tabOverrides)} open onOpenChange={onOpenChange} />);
  return { onOpenChange };
}

const tRaw = i18n.t as (key: string, options?: Record<string, unknown>) => string;
function tPanes(key: string, options?: Record<string, unknown>) {
  return tRaw(key, { ns: "panes", ...options });
}

describe("SessionBindDialog", () => {
  beforeEach(() => {
    listClaudeSessions.mockResolvedValue([
      { id: VALID_UUID, description: "fix the bug", modified_at: 1_700_000_000 },
    ] as never);
    touchBySessionId.mockResolvedValue(42 as never);
    updateResumeSource.mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when the tab is null", () => {
    const { container } = render(
      <SessionBindDialog tab={null} open onOpenChange={vi.fn()} />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("lists claude sessions for the tab project when opened", async () => {
    renderDialog();

    expect(await screen.findByText("fix the bug")).toBeInTheDocument();
    expect(listClaudeSessions).toHaveBeenCalledWith("/tmp/proj");
    expect(listCodexSessions).not.toHaveBeenCalled();
    // 未绑定的 tab 不提供解绑
    expect(screen.queryByRole("button", { name: tPanes("sessionBindUnbind") })).not.toBeInTheDocument();
  });

  it("prefers workspacePath over projectPath when loading candidates", async () => {
    renderDialog({ workspacePath: "/tmp/workspace" });

    await waitFor(() => expect(listClaudeSessions).toHaveBeenCalledWith("/tmp/workspace"));
  });

  it("queries codex sessions with wsl runtime info for codex tabs", async () => {
    listCodexSessions.mockResolvedValue([
      { id: VALID_UUID, description: "codex run", modified_at: 1_700_000_000 },
    ] as never);

    renderDialog({ cliTool: "codex", wsl: { distro: "Ubuntu" } as Tab["wsl"] });

    expect(await screen.findByText("codex run")).toBeInTheDocument();
    expect(listCodexSessions).toHaveBeenCalledWith("/tmp/proj", "wsl", "Ubuntu");
    expect(listClaudeSessions).not.toHaveBeenCalled();
  });

  it("shows the load error when listing sessions fails", async () => {
    listClaudeSessions.mockRejectedValue(new Error("scan failed"));

    renderDialog();

    expect(await screen.findByText(/scan failed/)).toBeInTheDocument();
  });

  it("shows the empty hint when there are no candidates", async () => {
    listClaudeSessions.mockResolvedValue([] as never);

    renderDialog();

    expect(await screen.findByText(tPanes("sessionBindEmpty"))).toBeInTheDocument();
  });

  it("binds a candidate, syncs launch history and closes the dialog", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const setTabResumeBinding = vi.fn();
    usePanesStore.setState({ setTabResumeBinding });

    renderDialog(undefined, onOpenChange);

    await user.click(await screen.findByText("fix the bug"));

    expect(setTabResumeBinding).toHaveBeenCalledWith("tab-1", VALID_UUID, "manual");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(touchBySessionId).toHaveBeenCalledWith(VALID_UUID);
    await waitFor(() => expect(updateResumeSource).toHaveBeenCalledWith(42, "manual"));
  });

  it("skips updateResumeSource when no launch history record matches", async () => {
    touchBySessionId.mockResolvedValue(null as never);
    const user = userEvent.setup();
    usePanesStore.setState({ setTabResumeBinding: vi.fn() });

    renderDialog();
    await user.click(await screen.findByText("fix the bug"));

    await waitFor(() => expect(touchBySessionId).toHaveBeenCalled());
    expect(updateResumeSource).not.toHaveBeenCalled();
  });

  it("keeps the manual bind button disabled until a valid UUID is entered", async () => {
    const user = userEvent.setup();
    const setTabResumeBinding = vi.fn();
    usePanesStore.setState({ setTabResumeBinding });

    renderDialog();

    const bindButton = screen.getByRole("button", { name: tPanes("sessionBindAction") });
    expect(bindButton).toBeDisabled();

    const input = screen.getByPlaceholderText(tPanes("sessionBindManualPlaceholder"));
    await user.type(input, "not-a-uuid");
    expect(bindButton).toBeDisabled();

    await user.clear(input);
    await user.type(input, `  ${VALID_UUID}  `);
    expect(bindButton).toBeEnabled();

    await user.click(bindButton);
    expect(setTabResumeBinding).toHaveBeenCalledWith("tab-1", VALID_UUID, "manual");
  });

  it("offers unbind only for a bound tab and clears the binding", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const setTabResumeBinding = vi.fn();
    usePanesStore.setState({ setTabResumeBinding });

    renderDialog({ resumeId: VALID_UUID, resumeIdSource: "manual" }, onOpenChange);

    await user.click(screen.getByRole("button", { name: tPanes("sessionBindUnbind") }));

    expect(setTabResumeBinding).toHaveBeenCalledWith("tab-1", undefined);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("marks the already-bound candidate in the list", async () => {
    renderDialog({ resumeId: VALID_UUID });

    expect(
      await screen.findByText(new RegExp(tPanes("sessionBindBoundMark")))
    ).toBeInTheDocument();
  });
});
