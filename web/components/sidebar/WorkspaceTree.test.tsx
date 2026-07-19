import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "@/types";
import WorkspaceTree, { getReorderedWorkspaceNames } from "./WorkspaceTree";

// --- i18n: t 直接回 key，便于断言 ---
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// --- dnd-kit: 渲染 children，屏蔽真实拖拽逻辑 ---
vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  closestCenter: vi.fn(),
  KeyboardSensor: vi.fn(),
  PointerSensor: vi.fn(),
  useSensor: vi.fn(),
  useSensors: vi.fn(() => []),
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
vi.mock("@/stores", () => ({
  useWorkspacesStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector(storeState),
    { getState: () => storeState },
  ),
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
      expandedWorkspaceId: null,
      expandWorkspace: vi.fn(),
      updateWorkspacePath: vi.fn(),
      reorder: vi.fn(),
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
});
