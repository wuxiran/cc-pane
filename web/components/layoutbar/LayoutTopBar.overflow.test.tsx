import "@/i18n";
import { DndContext } from "@dnd-kit/core";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createPanel } from "@/lib/paneTree";
import { useActivityBarStore, useLayoutUiStore, usePanesStore, useTerminalStatusStore } from "@/stores";
import { AGENT_CHAT_LAYOUT_ID } from "@/types";
import LayoutTopBar from "./LayoutTopBar";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ WebviewWindow: { getByLabel: vi.fn() } }));

describe("LayoutTopBar overflow integration", () => {
  beforeEach(() => {
    const layouts = Array.from({ length: 20 }, (_, index) => {
      const rootPane = createPanel();
      return { id: `layout-${index}`, name: `工作布局 ${index}`, kind: "normal" as const,
        rootPane, activePaneId: rootPane.id };
    });
    const specialRoot = createPanel();
    usePanesStore.setState({
      layouts: [...layouts,
        { id: "layout-starred", name: "星标", kind: "starred", rootPane: specialRoot, activePaneId: specialRoot.id },
        { id: AGENT_CHAT_LAYOUT_ID, name: "Agent Chat", kind: "normal", rootPane: specialRoot, activePaneId: specialRoot.id }],
      currentLayoutId: layouts[0].id, rootPane: layouts[0].rootPane, activePaneId: layouts[0].activePaneId,
      poppedOutTabs: new Set(), closedTabs: [],
    });
    useLayoutUiStore.setState({ switcherMode: "topbar", layoutBarDensity: "comfortable" });
    useActivityBarStore.setState({ appViewMode: "panes", orchestrationOverlayOpen: false });
    useTerminalStatusStore.setState({ statusMap: new Map() });
  });

  it.each(["comfortable", "compact"] as const)("keeps tools and new-layout outside the %s cards scroller and usable with twenty layouts", (density) => {
    useLayoutUiStore.setState({ layoutBarDensity: density });
    render(<TooltipProvider><DndContext><LayoutTopBar /></DndContext></TooltipProvider>);
    const viewport = screen.getByTestId("layout-strip-scroll");
    const cluster = screen.getByTestId("layout-preset-cluster");
    const add = screen.getByRole("button", { name: /新建布局|New layout/i });
    expect(within(viewport).getAllByRole("tab")).toHaveLength(20);
    expect(viewport).not.toContainElement(cluster);
    expect(viewport).not.toContainElement(screen.getByTestId("layout-view-trigger"));
    expect(viewport).not.toContainElement(add);
    expect(cluster).toContainElement(screen.getByTestId("layout-special-agent-chat"));
    expect(cluster).toContainElement(screen.getByTestId("layout-special-starred"));

    viewport.scrollLeft = 2500;
    fireEvent.scroll(viewport);
    fireEvent.click(within(viewport).getByRole("tab", { name: /工作布局 19/ }));
    expect(usePanesStore.getState().currentLayoutId).toBe("layout-19");
    fireEvent.click(add);
    const newId = usePanesStore.getState().currentLayoutId;
    expect(newId).not.toBe("layout-19");
    expect(viewport.querySelector(`[data-layout-id="${newId}"]`)).toHaveAttribute("aria-selected", "true");
    expect(within(viewport).getAllByRole("tab")).toHaveLength(21);
    expect(viewport).not.toContainElement(add);
  });

  it("keeps the selected card's reveal identity while renaming, then commits without changing selection", () => {
    render(<TooltipProvider><DndContext><LayoutTopBar /></DndContext></TooltipProvider>);
    const viewport = screen.getByTestId("layout-strip-scroll");
    act(() => usePanesStore.getState().switchLayout("layout-19"));
    fireEvent.doubleClick(within(viewport).getByRole("tab", { name: /工作布局 19/ }));
    const input = within(viewport).getByRole("textbox");
    expect(input).toHaveAttribute("data-layout-id", "layout-19");
    fireEvent.change(input, { target: { value: "最后一个布局" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(within(viewport).getByRole("tab", { name: /最后一个布局/ })).toHaveAttribute("aria-selected", "true");
    expect(usePanesStore.getState().currentLayoutId).toBe("layout-19");
  });
});
