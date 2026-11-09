import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutEntry, PaneNode, Tab } from "@/types";
import LayoutStage from "./LayoutStage";

const lifecycle = vi.hoisted(() => ({ mounts: [] as string[], unmounts: [] as string[] }));
const ensureAgentChatListener = vi.hoisted(() => vi.fn());

vi.mock("@/components/panes", async () => {
  const { useEffect, useContext } = await import("react");
  const { LayoutVisibilityContext } = await import("@/contexts/LayoutVisibilityContext");
  return {
    PaneContainer: ({ pane }: { pane: PaneNode }) => {
      const visible = useContext(LayoutVisibilityContext);
      useEffect(() => {
        lifecycle.mounts.push(pane.id);
        return () => {
          lifecycle.unmounts.push(pane.id);
        };
      }, [pane.id]);
      return <div data-testid={`pane-${pane.id}`} data-visible={String(visible)} />;
    },
  };
});
vi.mock("@/components/panes/StarredPanel", () => ({
  default: () => <div data-testid="starred-panel" />,
}));
vi.mock("@/stores/agentChatEvents", () => ({ ensureAgentChatListener }));

// 默认停泊延迟 30 s × 10 = 5 min。
const UNMOUNT_DELAY_MS = 300_000;

function terminalTab(id: string, extra: Partial<Tab> = {}): Tab {
  return { id, title: id, contentType: "terminal", projectId: "p", projectPath: "/p", sessionId: `s-${id}`, ...extra } as Tab;
}

function layout(id: string, tabs: Tab[] = [terminalTab(`${id}-tab`)]): LayoutEntry {
  return {
    id,
    name: id,
    kind: "normal",
    activePaneId: `${id}-pane`,
    rootPane: { type: "panel", id: `${id}-pane`, tabs, activeTabId: tabs[0]?.id ?? "" },
  } as LayoutEntry;
}

function renderStage(layouts: LayoutEntry[], currentLayoutId: string) {
  const current = layouts.find((entry) => entry.id === currentLayoutId)!;
  return render(
    <LayoutStage layouts={layouts} currentLayoutId={currentLayoutId} rootPane={current.rootPane} stageVisible />,
  );
}

function rerenderStage(view: ReturnType<typeof renderStage>, layouts: LayoutEntry[], currentLayoutId: string) {
  const current = layouts.find((entry) => entry.id === currentLayoutId)!;
  view.rerender(
    <LayoutStage layouts={layouts} currentLayoutId={currentLayoutId} rootPane={current.rootPane} stageVisible />,
  );
}

describe("LayoutStage 布局懒挂载（issue #43）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    lifecycle.mounts.length = 0;
    lifecycle.unmounts.length = 0;
    ensureAgentChatListener.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("启动时只挂当前布局，未访问的布局不挂载", () => {
    renderStage([layout("a"), layout("b"), layout("c")], "a");
    expect(screen.getByTestId("pane-a-pane")).toHaveAttribute("data-visible", "true");
    expect(screen.queryByTestId("pane-b-pane")).toBeNull();
    expect(screen.queryByTestId("pane-c-pane")).toBeNull();
    expect(lifecycle.mounts).toEqual(["a-pane"]);
  });

  it("首次切入才挂载；切回原布局时它仍 keep-alive（不重挂）", () => {
    const layouts = [layout("a"), layout("b"), layout("c")];
    const view = renderStage(layouts, "a");
    rerenderStage(view, layouts, "b");
    expect(screen.getByTestId("pane-b-pane")).toHaveAttribute("data-visible", "true");
    expect(screen.getByTestId("pane-a-pane")).toHaveAttribute("data-visible", "false");
    expect(screen.queryByTestId("pane-c-pane")).toBeNull();

    rerenderStage(view, layouts, "a");
    expect(screen.getByTestId("pane-a-pane")).toHaveAttribute("data-visible", "true");
    expect(lifecycle.mounts).toEqual(["a-pane", "b-pane"]);
    expect(lifecycle.unmounts).toEqual([]);
  });

  it("久未访问的布局到期卸载；切回时按首次访问重建，store 数据原样不动", () => {
    const layouts = [layout("a"), layout("b")];
    const snapshot = JSON.stringify(layouts);
    const view = renderStage(layouts, "a");
    rerenderStage(view, layouts, "b");

    act(() => { vi.advanceTimersByTime(UNMOUNT_DELAY_MS - 1_000); });
    expect(screen.getByTestId("pane-a-pane")).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(1_000); });
    expect(screen.queryByTestId("pane-a-pane")).toBeNull();
    expect(lifecycle.unmounts).toEqual(["a-pane"]);
    // 当前布局永不卸载
    expect(screen.getByTestId("pane-b-pane")).toBeInTheDocument();

    rerenderStage(view, layouts, "a");
    expect(screen.getByTestId("pane-a-pane")).toHaveAttribute("data-visible", "true");
    expect(lifecycle.mounts).toEqual(["a-pane", "b-pane", "a-pane"]);
    expect(JSON.stringify(layouts)).toBe(snapshot);
  });

  it("含浏览器 / 编辑器等卸载会丢状态的布局只懒挂、不卸载", () => {
    const layouts = [layout("a"), layout("web", [terminalTab("t"), { ...terminalTab("w"), contentType: "browser" } as Tab])];
    const view = renderStage(layouts, "web");
    rerenderStage(view, layouts, "a");
    act(() => { vi.advanceTimersByTime(UNMOUNT_DELAY_MS * 3); });
    expect(screen.getByTestId("pane-web-pane")).toBeInTheDocument();
    expect(lifecycle.unmounts).toEqual([]);
  });

  it("切回再切走会重新计时", () => {
    const layouts = [layout("a"), layout("b")];
    const view = renderStage(layouts, "a");
    rerenderStage(view, layouts, "b");
    act(() => { vi.advanceTimersByTime(UNMOUNT_DELAY_MS - 10_000); });
    rerenderStage(view, layouts, "a");
    rerenderStage(view, layouts, "b");
    act(() => { vi.advanceTimersByTime(UNMOUNT_DELAY_MS - 10_000); });
    expect(screen.getByTestId("pane-a-pane")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(screen.queryByTestId("pane-a-pane")).toBeNull();
  });

  it("删除的布局不残留；starred 布局走 StarredPanel", () => {
    const starred = { ...layout("star"), kind: "starred" } as LayoutEntry;
    const layouts = [layout("a"), starred];
    const view = renderStage(layouts, "star");
    expect(screen.getByTestId("starred-panel")).toBeInTheDocument();
    rerenderStage(view, [layout("a")], "a");
    expect(screen.queryByTestId("starred-panel")).toBeNull();
  });

  it("未挂载布局里有 agent-chat 时仍建立事件监听", async () => {
    const layouts = [layout("a"), layout("chat", [{ ...terminalTab("c"), contentType: "agent-chat" } as Tab])];
    renderStage(layouts, "a");
    expect(screen.queryByTestId("pane-chat-pane")).toBeNull();
    await vi.dynamicImportSettled();
    expect(ensureAgentChatListener).toHaveBeenCalled();
  });
});
