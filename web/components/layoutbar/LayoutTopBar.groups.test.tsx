import "@/i18n";
import type { ReactElement } from "react";
import { fireEvent, render as rtlRender, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DndContext } from "@dnd-kit/core";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createPanel } from "@/lib/paneTree";
import {
  useActivityBarStore,
  useLayoutUiStore,
  usePanesStore,
  useTerminalStatusStore,
  useWorkspacesStore,
} from "@/stores";
import type { LayoutEntry } from "@/types";
import LayoutTopBar from "./LayoutTopBar";

vi.mock("@/components/ui/toast", () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ WebviewWindow: { getByLabel: vi.fn() } }));

const render = (ui: ReactElement) => rtlRender(<TooltipProvider><DndContext>{ui}</DndContext></TooltipProvider>);

function layout(id: string, name: string, workspaceName?: string): LayoutEntry {
  const rootPane = createPanel();
  return { id, name, kind: "normal", rootPane, activePaneId: rootPane.id, workspaceName };
}

beforeEach(() => {
  const layouts = [
    layout("l1", "前端主屏", "frontend"),
    layout("l2", "独立", undefined),
    layout("l3", "前端调试", "frontend"),
    layout("l4", "前端测试", "frontend"),
  ];
  usePanesStore.setState({
    layouts,
    rootPane: layouts[1].rootPane,
    activePaneId: layouts[1].activePaneId,
    currentLayoutId: "l2",
    closedTabs: [],
    poppedOutTabs: new Set<string>(),
  });
  useActivityBarStore.setState({ appViewMode: "panes" });
  useLayoutUiStore.setState({ switcherMode: "topbar", layoutBarDensity: "comfortable", collapsedLayoutGroups: [], pinnedLayoutIds: [], pinnedLayoutSide: "left" });
  useTerminalStatusStore.setState({ statusMap: new Map() });
  useWorkspacesStore.setState({
    workspaces: [{ id: "w1", name: "frontend", alias: "前端", color: "cyan", createdAt: "2026-11-01", projects: [] }],
  });
});

function tabNames() {
  return screen.getAllByRole("tab").map((tab) => tab.getAttribute("data-layout-id"));
}

describe("布局条工作空间分组", () => {
  it("同一工作空间的布局成组排在一起，点组头折叠成一叠卡片，再点弹出列表可切换或展开", async () => {
    const user = userEvent.setup();
    render(<LayoutTopBar />);
    expect(tabNames()).toEqual(["l1", "l3", "l4", "l2"]);

    await user.click(screen.getByRole("button", { name: /折叠分组「前端」|Collapse group/ }));
    expect(useLayoutUiStore.getState().collapsedLayoutGroups).toEqual(["frontend"]);
    expect(tabNames()).toEqual(["l2"]);

    const deck = screen.getByRole("button", { name: /前端：3 个布局|前端: 3 layouts/ });
    await user.click(deck);
    const popover = await screen.findByRole("listbox");
    await user.click(within(popover).getByRole("option", { name: /前端调试/ }));
    expect(usePanesStore.getState().currentLayoutId).toBe("l3");
    // 当前布局在折叠组里时仍紧跟组头显示
    expect(tabNames()).toEqual(["l3", "l2"]);

    await user.click(screen.getByRole("button", { name: /前端：3 个布局|前端: 3 layouts/ }));
    await user.click(await screen.findByRole("button", { name: /展开分组「前端」|Expand group/ }));
    expect(useLayoutUiStore.getState().collapsedLayoutGroups).toEqual([]);
  });

  it("右键组内布局可折叠整组", async () => {
    const user = userEvent.setup();
    render(<LayoutTopBar />);
    fireEvent.contextMenu(screen.getAllByRole("tab")[0]);
    await user.click(await screen.findByRole("menuitem", { name: /折叠分组「前端」|Collapse group/ }));
    expect(useLayoutUiStore.getState().collapsedLayoutGroups).toEqual(["frontend"]);
  });

  it("「全部布局」下拉可搜索并切换", async () => {
    const user = userEvent.setup();
    render(<LayoutTopBar />);
    await user.click(screen.getByTestId("layout-all-trigger"));
    const search = await screen.findByRole("textbox", { name: /搜索布局|Search layouts/ });
    await user.type(search, "测试");
    const list = screen.getByRole("listbox");
    expect(within(list).getAllByRole("option")).toHaveLength(1);
    await user.keyboard("{Enter}");
    expect(usePanesStore.getState().currentLayoutId).toBe("l4");
  });

  it("右键固定：布局缩成图标常驻左端，可挪到右端、取消固定", async () => {
    const user = userEvent.setup();
    render(<LayoutTopBar />);
    const solo = screen.getAllByRole("tab").find((tab) => tab.getAttribute("data-layout-id") === "l2")!;
    fireEvent.contextMenu(solo);
    await user.click(await screen.findByRole("menuitem", { name: /^固定$|^Pin$/ }));
    expect(useLayoutUiStore.getState().pinnedLayoutIds).toEqual(["l2"]);

    const zone = screen.getByTestId("layout-pinned-zone");
    expect(zone).toHaveAttribute("data-side", "left");
    const pinned = within(zone).getByRole("tab", { name: "独立" });
    expect(pinned).toHaveTextContent("独");
    // 固定后不再出现在滚动卡片区
    expect(within(screen.getByTestId("layout-strip")).queryByRole("tab", { name: "独立" })).toBeNull();
    // 固定区在卡片区之前
    expect(zone.compareDocumentPosition(screen.getByTestId("layout-strip")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.contextMenu(pinned);
    await user.click(await screen.findByRole("menuitem", { name: /固定区移到右侧|Move pinned to the right/ }));
    const rightZone = screen.getByTestId("layout-pinned-zone");
    expect(rightZone).toHaveAttribute("data-side", "right");
    expect(rightZone.compareDocumentPosition(screen.getByTestId("layout-strip")) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();

    fireEvent.contextMenu(within(rightZone).getByRole("tab"));
    await user.click(await screen.findByRole("menuitem", { name: /取消固定|Unpin/ }));
    expect(screen.queryByTestId("layout-pinned-zone")).toBeNull();
  });
});
