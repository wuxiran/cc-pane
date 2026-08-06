import "@/i18n";
import type { ReactElement } from "react";
import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SortableLayoutTab from "./SortableLayoutTab";
import { deriveLayoutTypeSummary } from "./layoutTypeSummary";
import type { LayoutStatusSummary } from "./layoutStatusSummary";
import { createPanel } from "@/lib/paneTree";
import { useWorkspacesStore } from "@/stores";
import type { LayoutEntry, PaneNode, Tab } from "@/types";

const render = (ui: ReactElement) => rtlRender(<DndContext>{ui}</DndContext>);

function tab(id: string, contentType: Tab["contentType"], workspaceName?: string): Tab {
  return {
    id,
    title: id,
    contentType,
    projectId: "project-a",
    projectPath: "/work/cc-book",
    sessionId: null,
    workspaceName,
  };
}

function paneWith(...tabs: Tab[]): PaneNode {
  const panel = createPanel();
  panel.tabs = tabs;
  return panel;
}

const emptyStatus: LayoutStatusSummary = {
  running: 0,
  waitingInput: 0,
  blocked: 0,
  idle: 0,
  total: 0,
};

function renderTab(overrides: {
  layout?: Partial<LayoutEntry>;
  tree?: PaneNode;
  deletable?: boolean;
} = {}) {
  const tree = overrides.tree ?? paneWith(tab("t1", "terminal"));
  const layout = {
    id: "layout-1",
    name: "布局 1",
    rootPane: tree,
    ...overrides.layout,
  } as LayoutEntry;
  const handlers = {
    onSelect: vi.fn<() => void>(),
    onStartRename: vi.fn<() => void>(),
    onRequestDelete: vi.fn<() => void>(),
    onToggleDensity: vi.fn<() => void>(),
    onJumpToTab: vi.fn<(paneId: string, tabId: string) => void>(),
  };
  const typeCounts = deriveLayoutTypeSummary(tree, layout.kind);
  render(
    <SortableLayoutTab
      layout={layout}
      tree={tree}
      selected={false}
      tabCount={typeCounts.total}
      density="comfortable"
      typeCounts={typeCounts}
      statusSummary={emptyStatus}
      statusMap={new Map()}
      idleLabel="无会话"
      densityToggleLabel="切换到紧凑档"
      deletable={overrides.deletable ?? true}
      deleteLabel="删除布局"
      {...handlers}
    />,
  );
  return handlers;
}

describe("SortableLayoutTab", () => {
  beforeEach(() => {
    useWorkspacesStore.setState({ workspaces: [] });
  });

  describe("工作空间绑定标签", () => {
    it("manual 绑定：亮色 + 链条图标，名字后不带问号", () => {
      renderTab({ layout: { workspaceName: "cc-book" } });
      const label = document.querySelector("[data-binding-source='manual']");
      expect(label).toBeTruthy();
      expect(label?.textContent).toBe("cc-book");
      expect(label?.querySelector("svg")).toBeTruthy(); // Link2
    });

    it("derived 绑定：按标签推导，名字后带 ? 且无链条图标", () => {
      renderTab({ tree: paneWith(tab("t1", "terminal", "erp")) });
      const label = document.querySelector("[data-binding-source='derived']");
      expect(label).toBeTruthy();
      expect(label?.textContent).toBe("erp?");
      expect(label?.querySelector("svg")).toBeFalsy();
    });
  });

  describe("计数", () => {
    // 此前 tabCount 只数 terminal，其余六类完全不计——顶部数字与卡片内容对不上
    it("顶部总数覆盖全类型，且等于类型计数桁各桁之和", () => {
      renderTab({
        tree: paneWith(
          tab("t1", "terminal"),
          tab("b1", "browser"),
          tab("e1", "editor"),
          tab("m1", "mcp-config"),
        ),
      });
      const row = screen.getByTestId("layout-type-counts");
      const perGroup = Array.from(row.querySelectorAll("[data-type-group]")).map((el) =>
        Number(el.textContent),
      );
      expect(perGroup.reduce((a, b) => a + b, 0)).toBe(4);
      expect(screen.getByRole("tab")).toHaveTextContent("4");
    });

    it("空布局不渲染类型计数桁", () => {
      const empty = createPanel();
      empty.tabs = [];
      renderTab({ tree: empty });
      expect(screen.queryByTestId("layout-type-counts")).not.toBeInTheDocument();
    });

    it("点类型计数桁跳转，且不触发卡片本身的切换", () => {
      const handlers = renderTab({ tree: paneWith(tab("b1", "browser")) });
      fireEvent.click(screen.getByTestId("layout-type-counts").querySelector("button")!);
      expect(handlers.onJumpToTab).toHaveBeenCalledTimes(1);
      expect(handlers.onSelect).not.toHaveBeenCalled();
    });
  });

  describe("右键菜单（补齐后与 corner 行能力对等）", () => {
    it("含重命名与删除", async () => {
      const handlers = renderTab();
      fireEvent.contextMenu(screen.getByRole("tab"));

      const rename = await screen.findByRole("menuitem", { name: /重命名布局|Rename Layout/i });
      const remove = await screen.findByRole("menuitem", { name: /删除布局|Delete Layout/i });
      expect(remove).not.toHaveAttribute("data-disabled");

      fireEvent.click(rename);
      expect(handlers.onStartRename).toHaveBeenCalled();
    });

    it("最后一个布局时删除项禁用且改显不可删文案", async () => {
      const handlers = renderTab({ deletable: false });
      fireEvent.contextMenu(screen.getByRole("tab"));

      const remove = await screen.findByRole("menuitem", {
        name: /最后一个布局不可删除|The last layout cannot be deleted/i,
      });
      expect(remove).toHaveAttribute("data-disabled");
      fireEvent.click(remove);
      expect(handlers.onRequestDelete).not.toHaveBeenCalled();
    });

    it("星标布局不给重命名/删除/绑定，只留密度切换", async () => {
      renderTab({ layout: { kind: "starred" } });
      fireEvent.contextMenu(screen.getByRole("tab"));

      expect(await screen.findByRole("menuitem", { name: /切换到紧凑档/i })).toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: /重命名布局|Rename Layout/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: /删除布局|Delete Layout/i })).not.toBeInTheDocument();
    });
  });
});
