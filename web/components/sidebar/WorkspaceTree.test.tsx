import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "@/types";
import WorkspaceTree from "./WorkspaceTree";
import { getReorderedWorkspaceNames } from "./workspaceDnd";

// --- i18n: t 直接回 key，便于断言 ---
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: vi.fn() },
}));

vi.mock("@/components/ui/IconTooltipButton", () => ({
  IconTooltipButton: ({ label, children, ...props }: React.ComponentProps<"button"> & { label: string }) => (
    <button aria-label={label} {...props}>{children}</button>
  ),
}));

// --- dnd-kit: 渲染 children，屏蔽真实拖拽逻辑 ---
vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  closestCenter: vi.fn(),
  KeyboardSensor: vi.fn(),
  PointerSensor: vi.fn(),
  useSensor: vi.fn(),
  useSensors: vi.fn(() => []),
  useDroppable: vi.fn(() => ({ setNodeRef: vi.fn(), isOver: false })),
}));
vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  arrayMove: <T,>(arr: T[], from: number, to: number): T[] => {
    const copy = arr.slice();
    const [moved] = copy.splice(from, 1);
    copy.splice(to, 0, moved);
    return copy;
  },
  useSortable: () => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn(), transform: null, transition: undefined, isDragging: false }),
  verticalListSortingStrategy: vi.fn(),
}));
vi.mock("@dnd-kit/utilities", () => ({ CSS: { Transform: { toString: () => "" } } }));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// --- 子组件全部 stub 成轻量占位 ---
vi.mock("@/components/WorktreeManager", () => ({ default: () => null }));
vi.mock("./WorkspaceDialogs", () => ({ default: () => null }));
vi.mock("./ProjectListView", () => ({ default: () => null }));
vi.mock("./WorkspaceItem", () => ({
  default: ({ ws }: { ws: Workspace }) => <div data-testid="ws-item">{ws.name}</div>,
}));

const handleCreateWorkspace = vi.fn();
vi.mock("./useWorkspaceActions", () => ({
  useWorkspaceActions: () => ({
    handleCreateWorkspace,
    handleRenameWorkspace: vi.fn(),
    handleDeleteWorkspace: vi.fn(),
    handleSetWorkspaceAlias: vi.fn(),
    handleImportProject: vi.fn(),
    handleScanImport: vi.fn(),
    handleGitClone: vi.fn(),
    handleRemoveProject: vi.fn(),
    handleSetAlias: vi.fn(),
    handleMigrateProject: vi.fn(),
    gitBranches: {},
    dialogs: {},
  }),
}));

vi.mock("@/services", () => ({ worktreeService: { list: vi.fn(async () => []) } }));
vi.mock("@/services/runtime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/stores/useActivityBarStore", () => ({
  useActivityBarStore: { getState: () => ({ toggleFilesMode: vi.fn() }) },
}));
vi.mock("@/stores/useDialogStore", () => ({
  useDialogStore: (selector: (s: unknown) => unknown) => selector({ openWorkspaceEnvironment: vi.fn() }),
}));

// --- useWorkspacesStore: selector 化 + getState ---
let storeState: Record<string, unknown>;
// 终端模式接线后 WorkspaceTree 还订阅 usePanesStore（projects 模式下 selector 返回 null/常量）
const panesState = { layouts: [], rootPane: { type: "panel", id: "p", tabs: [], activeTabId: "" }, currentLayoutId: "l1" };
vi.mock("@/stores", () => ({
  useWorkspacesStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector(storeState),
    { getState: () => storeState },
  ),
  usePanesStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector(panesState),
    { getState: () => panesState },
  ),
}));
vi.mock("@/stores/useTerminalStatusStore", () => ({
  useTerminalStatusStore: (selector: (s: unknown) => unknown) => selector({ statusMap: new Map() }),
}));

let layoutState: Record<string, unknown>;
vi.mock("@/stores/useLayoutUiStore", () => ({
  useLayoutUiStore: (selector: (s: unknown) => unknown) => selector(layoutState),
}));

function makeWorkspace(over: Partial<Workspace>): Workspace {
  return {
    id: over.id ?? "ws",
    name: over.name ?? "ws",
    path: null,
    projects: [],
    ...over,
  } as Workspace;
}

describe("getReorderedWorkspaceNames", () => {
  const a = makeWorkspace({ id: "a", name: "alpha" });
  const b = makeWorkspace({ id: "b", name: "bravo" });
  const c = makeWorkspace({ id: "c", name: "charlie" });

  it("同一 id 返回 null", () => {
    expect(getReorderedWorkspaceNames([a, b, c], "a", "a")).toBeNull();
  });

  it("未知 id 返回 null", () => {
    expect(getReorderedWorkspaceNames([a, b, c], "a", "zzz")).toBeNull();
    expect(getReorderedWorkspaceNames([a, b, c], "zzz", "b")).toBeNull();
  });

  it("默认工作空间不参与拖拽排序", () => {
    const def = makeWorkspace({ id: "d", name: "default", isDefault: true });
    expect(getReorderedWorkspaceNames([def, a, b], "d", "a")).toBeNull();
    expect(getReorderedWorkspaceNames([def, a, b], "a", "d")).toBeNull();
  });

  it("跨 pinned 边界返回 null", () => {
    const pinned = makeWorkspace({ id: "a", name: "alpha", pinned: true });
    expect(getReorderedWorkspaceNames([pinned, b, c], "a", "b")).toBeNull();
  });

  it("跨 workspace group 返回 null", () => {
    const frontend = makeWorkspace({ id: "a", name: "alpha", group: "Frontend" });
    const backend = makeWorkspace({ id: "b", name: "bravo", group: "Backend" });
    expect(getReorderedWorkspaceNames([frontend, backend], "a", "b")).toBeNull();
  });

  it("合法重排返回新顺序的 name 数组", () => {
    expect(getReorderedWorkspaceNames([a, b, c], "a", "c")).toEqual(["bravo", "charlie", "alpha"]);
  });

  it("同为 pinned 时允许重排", () => {
    const pa = makeWorkspace({ id: "a", name: "alpha", pinned: true });
    const pb = makeWorkspace({ id: "b", name: "bravo", pinned: true });
    expect(getReorderedWorkspaceNames([pa, pb], "a", "b")).toEqual(["bravo", "alpha"]);
  });
});

describe("WorkspaceTree component", () => {
  beforeEach(() => {
    handleCreateWorkspace.mockClear();
    storeState = {
      workspaces: [],
      workspaceFilter: { query: "", colors: [], group: null },
      expandedWorkspaceId: null,
      expandWorkspace: vi.fn(),
      updateWorkspacePath: vi.fn(),
      reorder: vi.fn(),
      setWorkspaceFilter: vi.fn(),
      clearWorkspaceFilter: vi.fn(),
    };
    layoutState = {
      collapsedWorkspaceGroups: [],
      toggleWorkspaceGroup: vi.fn(),
    };
  });

  it("空工作空间时显示 noWorkspaces 与计数 0", () => {
    render(<WorkspaceTree onOpenTerminal={vi.fn()} />);
    expect(screen.getByText("noWorkspaces")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("渲染工作空间条目与计数", () => {
    storeState.workspaces = [
      makeWorkspace({ id: "a", name: "alpha" }),
      makeWorkspace({ id: "b", name: "bravo" }),
    ];
    render(<WorkspaceTree onOpenTerminal={vi.fn()} />);
    expect(screen.getAllByTestId("ws-item")).toHaveLength(2);
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.queryByText("noWorkspaces")).not.toBeInTheDocument();
  });

  it("点击新建工作空间按钮触发 handleCreateWorkspace", () => {
    render(<WorkspaceTree onOpenTerminal={vi.fn()} />);
    // 空态下存在多个「新建工作空间」入口（空状态 CTA + 底部按钮），点击其一即可
    fireEvent.click(screen.getAllByText("newWorkspace")[0]);
    expect(handleCreateWorkspace).toHaveBeenCalledTimes(1);
  });

  it("按分组分段渲染并给未分组工作空间单独的组头", () => {
    storeState.workspaces = [
      makeWorkspace({ id: "default", name: "default", isDefault: true }),
      makeWorkspace({ id: "a", name: "alpha", group: "Frontend" }),
      makeWorkspace({ id: "b", name: "bravo", group: "Frontend" }),
      makeWorkspace({ id: "c", name: "charlie" }),
    ];

    render(<WorkspaceTree onOpenTerminal={vi.fn()} />);

    expect(screen.getByText("Frontend")).toBeVisible();
    expect(screen.getByText("2")).toBeVisible();
    // 未分组项必须有自己的头，否则视觉上会被吸进上一个分组
    expect(screen.getByText("ungrouped")).toBeVisible();
    expect(screen.getAllByTestId("ws-item")).toHaveLength(4);
  });

  it("没有任何分组时不渲染未分组组头", () => {
    storeState.workspaces = [
      makeWorkspace({ id: "a", name: "alpha" }),
      makeWorkspace({ id: "b", name: "bravo" }),
    ];

    render(<WorkspaceTree onOpenTerminal={vi.fn()} />);

    expect(screen.queryByText("ungrouped")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("ws-item")).toHaveLength(2);
  });

  it("折叠未分组组头后隐藏未分组工作空间", () => {
    storeState.workspaces = [
      makeWorkspace({ id: "a", name: "alpha", group: "Frontend" }),
      makeWorkspace({ id: "c", name: "charlie" }),
    ];
    layoutState.collapsedWorkspaceGroups = ["__ungrouped__"];

    render(<WorkspaceTree onOpenTerminal={vi.fn()} />);

    expect(screen.getByText("ungrouped")).toBeVisible();
    expect(screen.getAllByTestId("ws-item")).toHaveLength(1);
  });

  it("隐藏已折叠分组的工作空间但保留组头", () => {
    storeState.workspaces = [
      makeWorkspace({ id: "a", name: "alpha", group: "Frontend" }),
      makeWorkspace({ id: "b", name: "bravo", group: "Frontend" }),
      makeWorkspace({ id: "c", name: "charlie" }),
    ];
    layoutState.collapsedWorkspaceGroups = ["Frontend"];

    render(<WorkspaceTree onOpenTerminal={vi.fn()} />);

    expect(screen.getByText("Frontend")).toBeVisible();
    expect(screen.queryByText("alpha")).not.toBeInTheDocument();
    expect(screen.queryByText("bravo")).not.toBeInTheDocument();
    expect(screen.getByText("charlie")).toBeVisible();
  });

  it("筛选时仍置顶显示默认工作空间", () => {
    storeState.workspaces = [
      makeWorkspace({ id: "default", name: "default", isDefault: true }),
      makeWorkspace({ id: "api", name: "api", group: "Backend", color: "green" }),
      makeWorkspace({ id: "web", name: "web", group: "Frontend", color: "blue" }),
    ];
    storeState.workspaceFilter = { query: "api", colors: ["green"], group: "Backend" };

    render(<WorkspaceTree onOpenTerminal={vi.fn()} />);

    expect(screen.getAllByTestId("ws-item").map((item) => item.textContent)).toEqual([
      "default",
      "api",
    ]);
  });

  it("点击筛选图标显示筛选条", () => {
    render(<WorkspaceTree onOpenTerminal={vi.fn()} />);

    expect(screen.queryByPlaceholderText("workspaceSearchPlaceholder")).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "workspaceFilterToggle" });
    expect(toggle).toHaveClass("opacity-0");

    fireEvent.click(toggle);

    expect(screen.getByPlaceholderText("workspaceSearchPlaceholder")).toBeVisible();
    expect(toggle).not.toHaveClass("opacity-0");
  });
});
