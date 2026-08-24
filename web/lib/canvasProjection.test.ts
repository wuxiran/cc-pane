import { describe, expect, it } from "vitest";
import { deriveParentEdges, derivePipeEdges, projectCanvasNodes, resolveCanvasEventNodes } from "./canvasProjection";
import type { TaskBinding, PaneNode } from "@/types";

const binding = (id: string, extra: Partial<TaskBinding> = {}): TaskBinding => ({
  id, title: id, role: "task", projectPath: "/p", cliTool: "claude", status: "running", progress: 0.5,
  sortOrder: 0, createdAt: "now", updatedAt: "now", ...extra,
});

const root: PaneNode = {
  type: "panel", id: "pane-1", activeTabId: "tab-1", tabs: [{
    id: "tab-1", title: "Terminal", contentType: "terminal", projectId: "p", projectPath: "/p", sessionId: "session-1",
    terminalRootPane: { type: "leaf", id: "leaf-1", sessionId: "session-1" }, activeTerminalPaneId: "leaf-1",
  }],
};

describe("canvasProjection", () => {
  it("keeps binding identity and derives read-only parent edges", () => {
    const nodes = projectCanvasNodes({ bindings: [binding("parent"), binding("child", { parentId: "parent", sessionId: "session-1" })], layouts: [{ id: "layout-1", rootPane: root }] });
    expect(nodes.find((node) => node.bindingId === "child")?.id).toBe("binding:child");
    expect(deriveParentEdges(nodes)).toEqual([{ id: "pipe:binding:parent->binding:child", sourceId: "binding:parent", targetId: "binding:child", readOnly: true }]);
  });

  it("falls back to an independent leaf when session and binding are missing", () => {
    const nodes = projectCanvasNodes({ bindings: [], layouts: [{ id: "layout-1", rootPane: root }] });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe("leaf:leaf-1");
  });

  it("isolates bindings to the selected layout", () => {
    const secondRoot: PaneNode = {
      ...root,
      id: "pane-2",
      tabs: root.tabs.map((tab) => ({
        ...tab,
        id: "tab-2",
        sessionId: "session-2",
        terminalRootPane: { type: "leaf", id: "leaf-2", sessionId: "session-2" },
        activeTerminalPaneId: "leaf-2",
      })),
    };
    const nodes = projectCanvasNodes({
      bindings: [
        binding("leader", { role: "leader", sessionId: "session-1" }),
        binding("worker", { role: "worker", parentId: "leader", sessionId: "session-2" }),
      ],
      layouts: [
        { id: "layout-1", rootPane: root },
        { id: "layout-2", rootPane: secondRoot },
      ],
      layoutId: "layout-1",
    });

    expect(nodes.filter((node) => node.bindingId).map((node) => node.bindingId)).toEqual(["leader"]);
    expect(nodes.find((node) => node.bindingId === "leader")?.layoutId).toBe("layout-1");
    expect(nodes.find((node) => node.bindingId === "worker")).toBeUndefined();

    const layoutTwoNodes = projectCanvasNodes({
      bindings: [
        binding("leader", { role: "leader", sessionId: "session-1" }),
        binding("worker", { role: "worker", parentId: "leader", sessionId: "session-2" }),
      ],
      layouts: [
        { id: "layout-1", rootPane: root },
        { id: "layout-2", rootPane: secondRoot },
      ],
      layoutId: "layout-2",
    });
    expect(layoutTwoNodes.find((node) => node.bindingId === "worker")?.layoutId).toBe("layout-2");
    expect(layoutTwoNodes.find((node) => node.bindingId === "leader")).toBeUndefined();
  });

  it("只投影运行中的 binding 和有活动 session 的未绑定终端", () => {
    const failedLeaf: PaneNode = {
      type: "panel", id: "pane-failed", activeTabId: "tab-failed", tabs: [{
        ...root.tabs[0],
        id: "tab-failed",
        sessionId: "session-failed",
        terminalRootPane: { type: "leaf", id: "leaf-failed", sessionId: null },
        activeTerminalPaneId: "leaf-failed",
      }],
    };
    const nodes = projectCanvasNodes({
      bindings: [
        binding("running", { sessionId: "session-1" }),
        binding("failed", { sessionId: "session-failed", status: "failed" }),
        binding("completed", { sessionId: "session-1", status: "completed" }),
      ],
      layouts: [{
        id: "layout-1",
        rootPane: {
          type: "split",
          id: "split-1",
          direction: "horizontal",
          children: [root, failedLeaf],
          sizes: [50, 50],
        },
      }],
      layoutId: "layout-1",
    });

    expect(nodes.filter((node) => node.bindingId).map((node) => node.bindingId)).toEqual(["running"]);
    expect(nodes.some((node) => node.id === "binding:failed")).toBe(false);
    expect(nodes.some((node) => node.id === "binding:completed")).toBe(false);
  });

  it("不让失败 binding 的重复活动叶子重新进入画布", () => {
    const duplicateRoot: PaneNode = {
      type: "panel",
      id: "pane-duplicate",
      activeTabId: "tab-duplicate",
      tabs: [{
        ...root.tabs[0],
        id: "tab-duplicate",
        sessionId: "session-failed",
        terminalRootPane: {
          type: "split",
          id: "split-duplicate",
          direction: "horizontal",
          children: [
            { type: "leaf", id: "leaf-failed-a", sessionId: "session-failed" },
            { type: "leaf", id: "leaf-failed-b", sessionId: "session-failed" },
          ],
          sizes: [50, 50],
        },
        activeTerminalPaneId: "leaf-failed-a",
      }],
    };
    const nodes = projectCanvasNodes({
      bindings: [binding("failed", { sessionId: "session-failed", status: "failed" })],
      layouts: [{ id: "layout-1", rootPane: duplicateRoot }],
      layoutId: "layout-1",
    });

    expect(nodes).toEqual([]);
  });

  it("does not project a terminal leaf without an active session", () => {
    const idleRoot: PaneNode = {
      type: "panel",
      id: "pane-idle",
      activeTabId: "tab-idle",
      tabs: [{
        ...root.tabs[0],
        id: "tab-idle",
        sessionId: null,
        terminalRootPane: { type: "leaf", id: "leaf-idle", sessionId: null },
        activeTerminalPaneId: "leaf-idle",
      }],
    };
    const nodes = projectCanvasNodes({ bindings: [], layouts: [{ id: "layout-1", rootPane: idleRoot }], layoutId: "layout-1" });
    expect(nodes).toEqual([]);
  });

  it("maps session-only pipe events to binding node ids", () => {
    const nodes = projectCanvasNodes({
      bindings: [binding("leader", { sessionId: "session-1" })],
      layouts: [{ id: "layout-1", rootPane: root }],
    });
    const event = {
      schemaVersion: 1,
      eventId: "event-1",
      correlationId: "correlation-1",
      sequence: 1,
      workspaceId: "workspace-1",
      kind: "message" as const,
      phase: "flowing" as const,
      fromSession: "session-1",
      toSession: "session-2",
      summary: "flowing",
      createdAt: "2026-08-24T00:00:00.000Z",
    };

    expect(resolveCanvasEventNodes([event], nodes)[0].sourceId).toBe("binding:leader");
    expect(resolveCanvasEventNodes([event], nodes)[0].targetId).toBe("session:session-2");
  });

  it("derives a visible pipe from a real event when no parentId was persisted", () => {
    const nodes = [
      { id: "binding:source", label: "Source", kind: "task" as const, bindingId: "source", status: "running" as const },
      { id: "binding:target", label: "Target", kind: "task" as const, bindingId: "target", status: "running" as const },
    ];
    const event = {
      schemaVersion: 1,
      eventId: "event-1",
      correlationId: "correlation-1",
      sequence: 1,
      workspaceId: "workspace-1",
      kind: "message" as const,
      phase: "flowing" as const,
      fromBinding: "source",
      toBinding: "target",
      summary: "message",
      createdAt: "2026-08-24T00:00:00.000Z",
    };

    expect(derivePipeEdges(nodes, [event])).toEqual([{
      id: "pipe:event:binding:source->binding:target",
      sourceId: "binding:source",
      targetId: "binding:target",
      readOnly: true,
    }]);
  });

  it("uses the tab parent link when a binding parent is unavailable", () => {
    const nodes = [
      { id: "leaf:leader", label: "Leader", kind: "terminal" as const, tabId: "tab-leader", status: "running" as const },
      { id: "leaf:worker", label: "Worker", kind: "terminal" as const, tabId: "tab-worker", parentTabId: "tab-leader", status: "running" as const },
    ];

    expect(deriveParentEdges(nodes)).toEqual([{
      id: "pipe:leaf:leader->leaf:worker",
      sourceId: "leaf:leader",
      targetId: "leaf:worker",
      readOnly: true,
    }]);
  });

  it("falls back from an unresolved binding endpoint to its live session node", () => {
    const nodes = [
      { id: "leaf:leader", label: "Leader", kind: "terminal" as const, sessionId: "session-leader", status: "running" as const },
      { id: "leaf:worker", label: "Worker", kind: "terminal" as const, sessionId: "session-worker", status: "running" as const },
    ];
    const event = {
      schemaVersion: 1,
      eventId: "event-fallback",
      correlationId: "correlation-fallback",
      sequence: 1,
      workspaceId: "workspace-1",
      kind: "message" as const,
      phase: "flowing" as const,
      fromBinding: "binding-not-mounted",
      toBinding: "binding-worker",
      fromSession: "session-leader",
      toSession: "session-worker",
      summary: "message",
      createdAt: "2026-08-24T00:00:00.000Z",
    };

    const normalized = resolveCanvasEventNodes([event], nodes)[0];
    expect(normalized.sourceId).toBe("leaf:leader");
    expect(normalized.targetId).toBe("leaf:worker");
    expect(derivePipeEdges(nodes, [normalized])).toEqual([{
      id: "pipe:event:leaf:leader->leaf:worker",
      sourceId: "leaf:leader",
      targetId: "leaf:worker",
      readOnly: true,
    }]);
  });

  it("infers edges from one leader to role-only workers", () => {
    const nodes = [
      { id: "binding:leader", label: "Leader", kind: "task" as const, role: "leader" as const, status: "running" as const },
      { id: "binding:worker", label: "Worker", kind: "task" as const, role: "worker" as const, status: "running" as const },
    ];

    expect(deriveParentEdges(nodes)).toEqual([{
      id: "pipe:binding:leader->binding:worker",
      sourceId: "binding:leader",
      targetId: "binding:worker",
      readOnly: true,
    }]);
  });

  it("uses dispatch envelope parent ids when the binding parent column is empty", () => {
    const nodes = projectCanvasNodes({
      bindings: [
        binding("leader", { role: "leader", sessionId: "session-leader" }),
        binding("worker", {
          role: "task",
          sessionId: "session-worker",
          metadata: {
            dispatchEnvelope: {
              parentBindingId: "leader",
              parentSessionId: "session-leader",
            },
          },
        }),
      ],
      layouts: [{ id: "layout-1", rootPane: root }],
    });

    const worker = nodes.find((node) => node.bindingId === "worker");
    expect(worker?.parentId).toBe("binding:leader");
    expect(worker?.parentSessionId).toBe("session-leader");
    expect(deriveParentEdges(nodes)).toEqual([{
      id: "pipe:binding:leader->binding:worker",
      sourceId: "binding:leader",
      targetId: "binding:worker",
      readOnly: true,
    }]);
  });
});
