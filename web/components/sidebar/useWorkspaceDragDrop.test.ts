import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { useWorkspacesStore } from "@/stores";
import { createTestWorkspace, resetTestDataCounter } from "@/test/utils/testData";
import { useWorkspaceDragDrop } from "./useWorkspaceDragDrop";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: vi.fn() },
}));

/** 构造一次跨组拖放事件：把 loose 拖到 Backend 组的 member 上 */
function crossGroupDrop() {
  return {
    active: { id: "ws-1", data: { current: undefined } },
    over: { id: "ws-2", data: { current: undefined } },
  } as never;
}

function groupHeaderDrop() {
  return {
    active: { id: "ws-1", data: { current: undefined } },
    over: {
      id: "ws-group:Backend",
      data: { current: { type: "workspace-group", group: "Backend" } },
    },
  } as never;
}

describe("useWorkspaceDragDrop", () => {
  let calls: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    resetTestDataCounter();
    calls = [];
    useWorkspacesStore.setState({
      workspaces: [
        createTestWorkspace({ id: "ws-1", name: "alpha" }),
        createTestWorkspace({ id: "ws-2", name: "bravo", group: "Backend" }),
      ],
      saveWorkspace: vi.fn(async () => {
        calls.push("save");
      }),
      reorder: vi.fn(async () => {
        calls.push("reorder");
      }),
      load: vi.fn(async () => {
        calls.push("load");
      }),
    } as never);
  });

  it("跨组拖放先改组再排序——顺序反了会让 saveWorkspace 抹掉刚写的 sort_order", async () => {
    const { result } = renderHook(() => useWorkspaceDragDrop());

    await act(async () => {
      await result.current.handleDragEnd(crossGroupDrop());
    });

    expect(calls).toEqual(["save", "reorder"]);
    expect(useWorkspacesStore.getState().saveWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ name: "alpha", group: "Backend" }),
    );
    expect(toast.success).toHaveBeenCalledWith("workspaceGroupChanged");
  });

  it("拖到分组头只发一次写，不下发排序", async () => {
    const { result } = renderHook(() => useWorkspaceDragDrop());

    await act(async () => {
      await result.current.handleDragEnd(groupHeaderDrop());
    });

    expect(calls).toEqual(["save"]);
  });

  it("改组失败时不继续排序，且报错", async () => {
    useWorkspacesStore.setState({
      saveWorkspace: vi.fn(async () => {
        calls.push("save");
        throw new Error("disk full");
      }),
    } as never);
    const { result } = renderHook(() => useWorkspaceDragDrop());

    await act(async () => {
      await result.current.handleDragEnd(crossGroupDrop());
    });

    expect(calls).toEqual(["save"]);
    expect(toast.error).toHaveBeenCalledWith("workspaceMoveGroupFailed");
  });

  it("排序失败时重新拉真值并提示部分失败（不做补偿性反向写）", async () => {
    useWorkspacesStore.setState({
      reorder: vi.fn(async () => {
        calls.push("reorder");
        throw new Error("locked");
      }),
    } as never);
    const { result } = renderHook(() => useWorkspaceDragDrop());

    await act(async () => {
      await result.current.handleDragEnd(crossGroupDrop());
    });

    expect(calls).toEqual(["save", "reorder", "load"]);
    expect(toast.warning).toHaveBeenCalledWith("workspaceGroupOrderPartialFailed");
    expect(toast.error).not.toHaveBeenCalled();
  });
});
