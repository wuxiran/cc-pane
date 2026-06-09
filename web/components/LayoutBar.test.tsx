import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LayoutBar from "./LayoutBar";
import { useActivityBarStore, usePanesStore } from "@/stores";
import { createPanel } from "@/stores/paneTreeHelpers";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: {
    getByLabel: vi.fn(),
  },
}));

function resetStores() {
  const rootPane = createPanel();
  usePanesStore.setState({
    rootPane,
    activePaneId: rootPane.id,
    layouts: [{
      id: "layout-1",
      name: "布局 1",
      rootPane,
      activePaneId: rootPane.id,
    }],
    currentLayoutId: "layout-1",
    closedTabs: [],
    poppedOutTabs: new Set<string>(),
  });
  useActivityBarStore.setState({
    activeView: "explorer",
    sidebarVisible: true,
    appViewMode: "panes",
    orchestrationOverlayOpen: false,
  });
}

describe("LayoutBar", () => {
  beforeEach(() => {
    resetStores();
  });

  it("点击布局按钮只打开选择器，不切换 home/panes 主视图", async () => {
    const user = userEvent.setup();
    useActivityBarStore.setState({ appViewMode: "home" });
    render(<LayoutBar />);

    await user.click(screen.getByRole("button", { name: /布局|Layout/i }));

    expect(await screen.findByRole("dialog", { name: /布局|Layouts/i })).toBeInTheDocument();
    expect(useActivityBarStore.getState().appViewMode).toBe("home");
  });

  it("右键重命名后保持编辑态并提交新布局名", async () => {
    const user = userEvent.setup();
    render(<LayoutBar />);

    await user.hover(screen.getByRole("button", { name: /布局|Layout/i }));
    const layoutRow = await screen.findByText("布局 1");
    fireEvent.contextMenu(layoutRow);
    await user.click(await screen.findByRole("menuitem", { name: /重命名|Rename/i }));

    const input = await screen.findByDisplayValue("布局 1");
    await waitFor(() => expect(input).toHaveFocus());

    await user.clear(input);
    await user.type(input, "工作布局{enter}");

    expect(usePanesStore.getState().layouts[0].name).toBe("工作布局");
    expect(screen.queryByDisplayValue("布局 1")).not.toBeInTheDocument();
    expect(await screen.findByText("工作布局")).toBeInTheDocument();
  });

  it("重命名时点击外部应确认并退出编辑态", async () => {
    const user = userEvent.setup();
    render(
      <>
        <LayoutBar />
        <button type="button">外部按钮</button>
      </>
    );

    await user.hover(screen.getByRole("button", { name: /布局|Layout/i }));
    fireEvent.contextMenu(await screen.findByText("布局 1"));
    await user.click(await screen.findByRole("menuitem", { name: /重命名|Rename/i }));

    const input = await screen.findByDisplayValue("布局 1");
    await waitFor(() => expect(input).toHaveFocus());
    await user.clear(input);
    await user.type(input, "外部确认布局");
    await user.click(screen.getByRole("button", { name: "外部按钮" }));

    expect(usePanesStore.getState().layouts[0].name).toBe("外部确认布局");
    expect(screen.queryByDisplayValue("外部确认布局")).not.toBeInTheDocument();
  });
});
