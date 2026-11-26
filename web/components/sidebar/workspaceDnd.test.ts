import { beforeEach, describe, expect, it } from "vitest";
import { createTestWorkspace, resetTestDataCounter } from "@/test/utils/testData";
import { UNGROUPED_WORKSPACE_FILTER } from "@/stores/useWorkspacesStore";
import { getReorderedWorkspaceNames, resolveWorkspaceDrop } from "./workspaceDnd";

beforeEach(() => {
  resetTestDataCounter();
});

describe("getReorderedWorkspaceNames", () => {
  it("returns reordered workspace names within the same pinned group", () => {
    const ws1 = createTestWorkspace({ id: "ws-1", name: "ws-1", pinned: false });
    const ws2 = createTestWorkspace({ id: "ws-2", name: "ws-2", pinned: false });
    const ws3 = createTestWorkspace({ id: "ws-3", name: "ws-3", pinned: false });

    expect(
      getReorderedWorkspaceNames([ws1, ws2, ws3], "ws-3", "ws-1"),
    ).toEqual(["ws-3", "ws-1", "ws-2"]);
    expect(
      getReorderedWorkspaceNames([ws1, ws2, ws3], "ws-1", "ws-3"),
    ).toEqual(["ws-2", "ws-3", "ws-1"]);
  });

  it("returns null for a self drop or unknown ids", () => {
    const ws1 = createTestWorkspace({ id: "ws-1", name: "ws-1" });
    const ws2 = createTestWorkspace({ id: "ws-2", name: "ws-2" });

    expect(getReorderedWorkspaceNames([ws1, ws2], "ws-1", "ws-1")).toBeNull();
    expect(getReorderedWorkspaceNames([ws1, ws2], "ws-1", "zzz")).toBeNull();
    expect(getReorderedWorkspaceNames([ws1, ws2], "zzz", "ws-2")).toBeNull();
  });

  it("never reorders the default workspace, on either side", () => {
    const def = createTestWorkspace({ id: "ws-0", name: "default", isDefault: true });
    const ws1 = createTestWorkspace({ id: "ws-1", name: "ws-1" });

    expect(getReorderedWorkspaceNames([def, ws1], "ws-0", "ws-1")).toBeNull();
    expect(getReorderedWorkspaceNames([def, ws1], "ws-1", "ws-0")).toBeNull();
  });

  it("allows reorder when both sides are pinned", () => {
    const pa = createTestWorkspace({ id: "ws-1", name: "ws-1", pinned: true });
    const pb = createTestWorkspace({ id: "ws-2", name: "ws-2", pinned: true });

    expect(getReorderedWorkspaceNames([pa, pb], "ws-1", "ws-2")).toEqual(["ws-2", "ws-1"]);
  });

  it("ignores drag attempts across pinned boundaries", () => {
    const pinned = createTestWorkspace({ id: "ws-1", name: "ws-1", pinned: true });
    const normal = createTestWorkspace({ id: "ws-2", name: "ws-2", pinned: false });

    expect(
      getReorderedWorkspaceNames([pinned, normal], "ws-2", "ws-1"),
    ).toBeNull();
  });

  // 纯排序不跨组——跨组由 resolveWorkspaceDrop 走 regroup 分支处理，不经过这里
  it("ignores drag attempts across workspace groups", () => {
    const frontend = createTestWorkspace({ id: "ws-1", name: "ws-1", group: "Frontend" });
    const backend = createTestWorkspace({ id: "ws-2", name: "ws-2", group: "Backend" });

    expect(
      getReorderedWorkspaceNames([frontend, backend], "ws-2", "ws-1"),
    ).toBeNull();
  });

  it("allows drag reorder within the same workspace group", () => {
    const ws1 = createTestWorkspace({ id: "ws-1", name: "ws-1", group: "Frontend" });
    const ws2 = createTestWorkspace({ id: "ws-2", name: "ws-2", group: "Frontend" });

    expect(
      getReorderedWorkspaceNames([ws1, ws2], "ws-2", "ws-1"),
    ).toEqual(["ws-2", "ws-1"]);
  });
});

describe("resolveWorkspaceDrop", () => {
  const groupTarget = (group: string) => ({
    id: `ws-group:${group}`,
    type: "workspace-group",
    group,
  });

  it("拖到分组头 → 改组，且不下发排序（位置交给后端排序律）", () => {
    const loose = createTestWorkspace({ id: "ws-1", name: "alpha" });
    const member = createTestWorkspace({ id: "ws-2", name: "bravo", group: "Backend" });

    expect(resolveWorkspaceDrop([loose, member], "ws-1", groupTarget("Backend"))).toEqual({
      kind: "regroup",
      workspaceName: "alpha",
      nextGroup: "Backend",
    });
  });

  it("拖到未分组头 → 清空 group", () => {
    const member = createTestWorkspace({ id: "ws-1", name: "alpha", group: "Backend" });

    expect(
      resolveWorkspaceDrop([member], "ws-1", groupTarget(UNGROUPED_WORKSPACE_FILTER)),
    ).toEqual({ kind: "regroup", workspaceName: "alpha", nextGroup: undefined });
  });

  it("拖到自己所在分组的头 → 空操作", () => {
    const member = createTestWorkspace({ id: "ws-1", name: "alpha", group: "Backend" });

    expect(resolveWorkspaceDrop([member], "ws-1", groupTarget("Backend"))).toBeNull();
  });

  it("拖到他组成员上 → 改组并插到该成员位置", () => {
    const front = createTestWorkspace({ id: "ws-1", name: "alpha", group: "Frontend" });
    const back = createTestWorkspace({ id: "ws-2", name: "bravo", group: "Backend" });

    expect(resolveWorkspaceDrop([front, back], "ws-1", { id: "ws-2" })).toEqual({
      kind: "regroup",
      workspaceName: "alpha",
      nextGroup: "Backend",
      orderedNames: ["bravo", "alpha"],
    });
  });

  it("跨组且跨 pinned 边界 → 只改组，不下发排序", () => {
    const normal = createTestWorkspace({ id: "ws-1", name: "alpha", group: "Frontend" });
    const pinned = createTestWorkspace({
      id: "ws-2",
      name: "bravo",
      group: "Backend",
      pinned: true,
    });

    expect(resolveWorkspaceDrop([normal, pinned], "ws-1", { id: "ws-2" })).toEqual({
      kind: "regroup",
      workspaceName: "alpha",
      nextGroup: "Backend",
      orderedNames: undefined,
    });
  });

  it("同组成员之间 → 退化为纯排序", () => {
    const a = createTestWorkspace({ id: "ws-1", name: "alpha", group: "Frontend" });
    const b = createTestWorkspace({ id: "ws-2", name: "bravo", group: "Frontend" });

    expect(resolveWorkspaceDrop([a, b], "ws-2", { id: "ws-1" })).toEqual({
      kind: "reorder",
      orderedNames: ["bravo", "alpha"],
    });
  });

  it("默认工作空间任一侧命中都拒绝", () => {
    const def = createTestWorkspace({ id: "ws-0", name: "default", isDefault: true });
    const other = createTestWorkspace({ id: "ws-1", name: "alpha", group: "Backend" });

    expect(resolveWorkspaceDrop([def, other], "ws-0", groupTarget("Backend"))).toBeNull();
    expect(resolveWorkspaceDrop([def, other], "ws-1", { id: "ws-0" })).toBeNull();
  });
});
