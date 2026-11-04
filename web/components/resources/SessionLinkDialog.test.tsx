import "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionLinkRequest } from "@/services/importService";

const state = vi.hoisted(() => ({
  layouts: [] as Array<{ id: string; tree: unknown }>,
  workspaces: [] as Array<{ name: string; projects: Array<{ path: string }> }>,
  store: {
    currentLayoutId: "l1",
    switchLayout: vi.fn(),
    setActivePane: vi.fn(),
    selectTab: vi.fn(),
    setActiveTerminalPane: vi.fn(),
  },
  load: vi.fn(async () => {}),
  toastErr: vi.fn(),
}));

vi.mock("@/stores", () => ({
  usePanesStore: { getState: () => state.store },
  useWorkspacesStore: {
    getState: () => ({ load: state.load, workspaces: state.workspaces }),
  },
}));
vi.mock("@/stores/paneLayoutHelpers", () => ({
  eachLayoutTree: (_: unknown, fn: (layout: { id: string }, tree: unknown) => void) =>
    state.layouts.forEach((layout) => fn(layout, layout.tree)),
}));
vi.mock("@/lib/paneTree", () => ({
  collectPanels: (tree: unknown) => tree,
}));
vi.mock("@/lib/feedback", () => ({ toastErr: state.toastErr, toastOk: vi.fn() }));

import SessionLinkDialog from "./SessionLinkDialog";

const link: SessionLinkRequest = {
  resource: "session",
  cli: "claude",
  id: "abc",
  project: "/work/app",
};

describe("SessionLinkDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.layouts = [];
    state.workspaces = [{ name: "ws", projects: [{ path: "/work/app" }] }];
  });

  it("会话已打开时直接跳转，不弹确认也不新开终端", async () => {
    state.layouts = [
      { id: "l2", tree: [{ id: "p1", tabs: [{ id: "t1", resumeId: "abc" }] }] },
    ];
    const onOpenTerminal = vi.fn();
    const onDone = vi.fn();
    render(<SessionLinkDialog link={link} onOpenTerminal={onOpenTerminal} onDone={onDone} />);

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(state.store.switchLayout).toHaveBeenCalledWith("l2");
    expect(state.store.selectTab).toHaveBeenCalledWith("p1", "t1");
    expect(onOpenTerminal).not.toHaveBeenCalled();
  });

  it("项目未注册时拒绝，不启动 CLI", async () => {
    const onOpenTerminal = vi.fn();
    const onDone = vi.fn();
    render(
      <SessionLinkDialog
        link={{ ...link, project: "/tmp/evil" }}
        onOpenTerminal={onOpenTerminal}
        onDone={onDone}
      />,
    );

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(state.toastErr).toHaveBeenCalled();
    expect(onOpenTerminal).not.toHaveBeenCalled();
  });

  it("已注册项目要用户确认后才恢复；取消则不启动", async () => {
    const user = userEvent.setup();
    const onOpenTerminal = vi.fn();
    const onDone = vi.fn();
    const view = render(
      <SessionLinkDialog link={link} onOpenTerminal={onOpenTerminal} onDone={onDone} />,
    );

    await screen.findByText("/work/app");
    expect(onOpenTerminal).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /取消|Cancel/i }));
    expect(onOpenTerminal).not.toHaveBeenCalled();
    view.unmount();

    render(<SessionLinkDialog link={link} onOpenTerminal={onOpenTerminal} onDone={onDone} />);
    await user.click(await screen.findByRole("button", { name: /恢复会话|Resume Session/i }));
    expect(onOpenTerminal).toHaveBeenCalledWith({
      path: "/work/app",
      workspaceName: "ws",
      cliTool: "claude",
      resumeId: "abc",
    });
  });
});
