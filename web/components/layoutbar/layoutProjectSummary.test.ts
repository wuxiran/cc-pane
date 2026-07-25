import { describe, expect, it } from "vitest";
import { createPanel } from "@/stores/paneTreeHelpers";
import type { Tab, TerminalStatusInfo, Workspace } from "@/types";
import { deriveLayoutProjectSummary } from "./layoutProjectSummary";

function terminalTab(
  id: string,
  projectId: string,
  projectPath: string,
  sessionId: string | null = null,
): Tab {
  return {
    id,
    title: id,
    contentType: "terminal",
    projectId,
    projectPath,
    sessionId,
  };
}

function status(sessionId: string, value: TerminalStatusInfo["status"]): TerminalStatusInfo {
  return {
    sessionId,
    status: value,
    lastOutputAt: 1,
    updatedAt: 1,
  };
}

const workspaces: Workspace[] = [
  {
    id: "workspace-1",
    name: "workspace",
    createdAt: "2026-07-25",
    projects: [
      { id: "project-a", path: "/work/cc-book", alias: "CC-Panes" },
      { id: "project-b", path: "/work/vms" },
      { id: "project-c", path: "/work/erp" },
    ],
  },
];

describe("deriveLayoutProjectSummary", () => {
  it("按项目去重、保留前两项并返回溢出计数", () => {
    const rootPane = createPanel();
    rootPane.tabs = [
      terminalTab("tab-a-1", "project-a", "/work/cc-book"),
      terminalTab("tab-a-2", "project-a", "/work/cc-book"),
      terminalTab("tab-b", "project-b", "/work/vms"),
      terminalTab("tab-c", "project-c", "/work/erp"),
    ];

    expect(deriveLayoutProjectSummary(rootPane, workspaces, new Map())).toEqual({
      projects: [
        { id: "project-a", name: "CC-Panes", status: null },
        { id: "project-b", name: "vms", status: null },
      ],
      overflow: 1,
    });
  });

  it("复用会话状态优先级聚合同一项目的状态", () => {
    const rootPane = createPanel();
    rootPane.tabs = [
      terminalTab("tab-a-1", "project-a", "/work/cc-book", "session-busy"),
      terminalTab("tab-a-2", "project-a", "/work/cc-book", "session-error"),
    ];
    const statusMap = new Map([
      ["session-busy", status("session-busy", "toolRunning")],
      ["session-error", status("session-error", "error")],
    ]);

    expect(deriveLayoutProjectSummary(rootPane, workspaces, statusMap).projects[0]).toEqual({
      id: "project-a",
      name: "CC-Panes",
      status: "error",
    });
  });

  it("忽略没有所属项目的默认空标签", () => {
    expect(deriveLayoutProjectSummary(createPanel(), workspaces, new Map())).toEqual({
      projects: [],
      overflow: 0,
    });
  });
});
