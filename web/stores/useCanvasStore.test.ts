import { describe, expect, it, beforeEach } from "vitest";
import { canvasSnapshotService } from "@/services/canvasSnapshotService";
import { useCanvasStore } from "@/stores/useCanvasStore";
import { useCanvasDisplayStore } from "@/stores/useCanvasDisplayStore";
import type { CanvasNodeProjection } from "@/types/canvas";

const scopeA = { workspaceId: "workspace-1", layoutId: "layout-1" };
const scopeB = { workspaceId: "workspace-1", layoutId: "layout-2" };
const scopeC = { workspaceId: "workspace-2", layoutId: "layout-1" };

const node = (id: string, position?: CanvasNodeProjection["position"]): CanvasNodeProjection => ({
  id,
  label: id,
  kind: "terminal",
  leafId: id,
  layoutId: scopeA.layoutId,
  status: "idle",
  position,
});

describe("canvas snapshot", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useCanvasStore.setState({ nodes: [], events: [], snapshot: null, nodePositions: {}, manualNodeIds: {}, pendingRestoreNodeIds: {}, positionScopeKey: null });
    useCanvasDisplayStore.setState({ mode: "panel", animationIntensity: "full" });
  });

  it("round-trips a versioned snapshot through the scoped service fallback", () => {
    const snapshot = useCanvasStore.getState().saveSnapshot(scopeA, {
      animationIntensity: "reduced",
      displayMode: "canvas",
    });
    expect(canvasSnapshotService.load(scopeA)).toMatchObject({
      version: 2,
      workspaceId: "workspace-1",
      layoutId: "layout-1",
      displayMode: "canvas",
      animationIntensity: "full",
    });
    expect(canvasSnapshotService.load(scopeA)?.nodes).toEqual([]);
    expect(useCanvasStore.getState().snapshot).toEqual(snapshot);
  });

  it("隔离 workspaceId + layoutId 的 storage key", () => {
    const snapshotA = useCanvasStore.getState().saveSnapshot(scopeA);
    const snapshotB = useCanvasStore.getState().saveSnapshot(scopeB);
    const snapshotC = useCanvasStore.getState().saveSnapshot(scopeC);

    expect(canvasSnapshotService.load(scopeA)).toEqual(snapshotA);
    expect(canvasSnapshotService.load(scopeB)).toEqual(snapshotB);
    expect(canvasSnapshotService.load(scopeC)).toEqual(snapshotC);
    expect(window.localStorage.length).toBe(3);
  });

  it("scope 切换时加载对应快照，找不到时清空旧 snapshot", () => {
    const snapshotA = useCanvasStore.getState().saveSnapshot(scopeA);

    expect(useCanvasStore.getState().loadSnapshot(scopeA)).toEqual(snapshotA);
    expect(useCanvasStore.getState().loadSnapshot(scopeB)).toBeNull();
    expect(useCanvasStore.getState().snapshot).toBeNull();
  });

  it("加载快照时恢复现存节点位置和 display 设置，并使用完整动画", () => {
    useCanvasStore.setState({ nodes: [node("kept", { x: 12, y: 24, width: 80, height: 40 }), node("removed")] });
    useCanvasStore.getState().saveSnapshot(scopeA, {
      displayMode: "canvas",
      animationIntensity: "reduced",
      customizedNodeIds: ["kept"],
      nodes: [node("kept", { x: 100, y: 120, width: 200, height: 60 }), node("removed", { x: 8, y: 8, width: 10, height: 10 })],
    });
    useCanvasStore.setState({
      nodes: [node("kept"), node("new")],
      snapshot: null,
    });

    expect(useCanvasStore.getState().loadSnapshot(scopeA)).not.toBeNull();
    expect(useCanvasStore.getState().nodes).toEqual([
      node("kept", { x: 100, y: 120, width: 200, height: 60 }),
      node("new"),
    ]);
    expect(useCanvasDisplayStore.getState()).toMatchObject({ mode: "canvas", animationIntensity: "full" });
  });

  it("忽略没有 customizedNodeIds 的旧自动布局快照", () => {
    const legacySnapshot = {
      version: 1 as const,
      ...scopeA,
      savedAt: new Date().toISOString(),
      displayMode: "canvas" as const,
      animationIntensity: "full" as const,
      nodes: [node("legacy", { x: 180, y: 90, width: 360, height: 240 })],
    };
    canvasSnapshotService.save(scopeA, legacySnapshot);
    useCanvasStore.setState({ nodes: [node("legacy")], snapshot: null });

    useCanvasStore.getState().loadSnapshot(scopeA);

    expect(useCanvasStore.getState().nodePositions).toEqual({});
    expect(useCanvasStore.getState().manualNodeIds).toEqual({});
  });

  it("keeps explicit positions when projection registers after snapshot load", () => {
    const explicit = { x: 180, y: 90, width: 360, height: 240 };
    canvasSnapshotService.save(scopeA, {
      version: 1,
      ...scopeA,
      savedAt: new Date().toISOString(),
      displayMode: "canvas",
      animationIntensity: "full",
      customizedNodeIds: ["late-node"],
      nodes: [node("late-node", explicit)],
    });

    useCanvasStore.getState().loadSnapshot(scopeA);
    useCanvasStore.getState().setNodes([node("late-node")]);

    expect(useCanvasStore.getState().nodePositions["late-node"]).toEqual(explicit);
    expect(useCanvasStore.getState().manualNodeIds["late-node"]).toBe(true);
    expect(useCanvasStore.getState().nodes[0].position).toEqual(explicit);
  });

  it("does not discard restored positions while projection is temporarily empty", () => {
    const explicit = { x: 180, y: 90, width: 360, height: 240 };
    canvasSnapshotService.save(scopeA, {
      version: 1,
      ...scopeA,
      savedAt: new Date().toISOString(),
      displayMode: "canvas",
      animationIntensity: "full",
      customizedNodeIds: ["late-node"],
      nodes: [node("late-node", explicit)],
    });

    useCanvasStore.getState().loadSnapshot(scopeA);
    useCanvasStore.getState().setNodes([]);

    expect(useCanvasStore.getState().nodePositions["late-node"]).toEqual(explicit);
    expect(useCanvasStore.getState().pendingRestoreNodeIds["late-node"]).toBe(true);

    useCanvasStore.getState().setNodes([node("late-node")]);

    expect(useCanvasStore.getState().pendingRestoreNodeIds).toEqual({});
    expect(useCanvasStore.getState().nodes[0].position).toEqual(explicit);
  });

  it("scope miss clears loaded positions and restores complete animation", () => {
    useCanvasStore.setState({
      nodes: [node("kept", { x: 10, y: 20, width: 30, height: 40 })],
      snapshot: { version: 1, ...scopeA, savedAt: new Date().toISOString(), displayMode: "canvas", animationIntensity: "reduced", nodes: [node("kept", { x: 10, y: 20, width: 30, height: 40 })] },
      manualNodeIds: {},
      nodePositions: {},
    });
    useCanvasDisplayStore.setState({ mode: "canvas", animationIntensity: "reduced" });

    expect(useCanvasStore.getState().loadSnapshot(scopeB)).toBeNull();
    expect(useCanvasStore.getState().nodes).toEqual([node("kept")]);
    expect(useCanvasDisplayStore.getState()).toMatchObject({ mode: "canvas", animationIntensity: "full" });
  });

  it("keeps a dragged position in the active Canvas scope", () => {
    useCanvasStore.setState({ nodes: [node("kept")] });
    useCanvasStore.getState().loadSnapshot(scopeA);
    useCanvasStore.getState().setNodePosition("kept", { x: 220, y: 140, width: 320, height: 220 });

    expect(useCanvasStore.getState().nodes[0].position).toEqual({ x: 220, y: 140, width: 320, height: 220 });
    expect(useCanvasStore.getState().nodePositions.kept).toEqual({ x: 220, y: 140, width: 320, height: 220 });
  });

  it("does not retain an automatic first-measurement position", () => {
    useCanvasStore.getState().setNodes([node("automatic", { x: 12, y: 24, width: 800, height: 600 })]);

    expect(useCanvasStore.getState().nodes[0].position).toBeUndefined();
    expect(useCanvasStore.getState().nodePositions).toEqual({});
  });

  it("writes v2 geometry only, so media URLs and run metadata are not snapshotted", () => {
    const mediaNode: CanvasNodeProjection = {
      id: "media:poster",
      label: "Poster",
      kind: "media",
      layoutId: scopeA.layoutId,
      status: "completed",
      media: {
        mediaKind: "image",
        runStatus: "succeeded",
        previewUrl: "/api/media/assets/asset-1/content",
        assetId: "asset-1",
      },
      position: { x: 20, y: 30, width: 360, height: 240 },
    };
    useCanvasStore.setState({ nodes: [mediaNode] });

    const snapshot = useCanvasStore.getState().saveSnapshot(scopeA, {
      customizedNodeIds: [mediaNode.id],
      nodes: [mediaNode],
    });

    expect(snapshot.version).toBe(2);
    expect(snapshot.nodes).toEqual([{
      id: mediaNode.id,
      position: mediaNode.position,
    }]);
    expect(JSON.stringify(snapshot)).not.toContain("asset-1");
  });
});
