import { describe, expect, it } from "vitest";
import { pickPaneContextProject, pickWorkspaceMethods } from "./WorkspaceEmptyActions";
import type { LaunchRecord } from "@/services";
import type { Panel, Tab, Workspace } from "@/types";

let seq = 0;

function record(overrides: Partial<LaunchRecord> = {}): LaunchRecord {
  seq += 1;
  return {
    id: seq,
    projectId: `proj-${seq}`,
    projectName: `proj-${seq}`,
    projectPath: `/tmp/proj-${seq}`,
    launchedAt: new Date(2026, 0, seq).toISOString(),
    ...overrides,
  };
}

describe("pickWorkspaceMethods", () => {
  it("按 workspaceName 过滤并按 CLI×运行环境去重（保留最新一条）", () => {
    const records = [
      record({ workspaceName: "ws-a", cliTool: "claude", runtimeKind: "local" }),
      record({ workspaceName: "ws-a", cliTool: "claude", runtimeKind: "local" }),
      record({ workspaceName: "ws-a", cliTool: "claude", runtimeKind: "wsl" }),
      record({ workspaceName: "ws-b", cliTool: "codex", runtimeKind: "local" }),
    ];

    const methods = pickWorkspaceMethods(records, "ws-a");

    expect(methods).toHaveLength(2);
    expect(methods[0]).toBe(records[0]);
    expect(methods.map((m) => `${m.cliTool}|${m.runtimeKind}`)).toEqual([
      "claude|local",
      "claude|wsl",
    ]);
  });

  it("排除纯终端记录并遵守 max 上限", () => {
    const records = [
      record({ workspaceName: "ws-a", cliTool: "none" }),
      record({ workspaceName: "ws-a", cliTool: undefined }),
      record({ workspaceName: "ws-a", cliTool: "claude", runtimeKind: "local" }),
      record({ workspaceName: "ws-a", cliTool: "claude", runtimeKind: "wsl" }),
      record({ workspaceName: "ws-a", cliTool: "codex", runtimeKind: "local" }),
    ];

    expect(pickWorkspaceMethods(records, "ws-a")).toHaveLength(3);
    expect(pickWorkspaceMethods(records, "ws-a", 2)).toHaveLength(2);
    expect(pickWorkspaceMethods(records, "ws-missing")).toHaveLength(0);
  });
});

function workspace(paths: string[]): Workspace {
  return {
    id: "ws",
    name: "ws",
    createdAt: "2026-01-01T00:00:00Z",
    projects: paths.map((path, index) => ({ id: `p-${index}`, path })),
  };
}

function tab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: `tab-${(seq += 1)}`,
    title: "Terminal",
    contentType: "terminal",
    projectId: "",
    projectPath: "",
    sessionId: null,
    ...overrides,
  };
}

function panel(tabs: Tab[]): Panel {
  return { type: "panel", id: "pane-1", tabs, activeTabId: tabs[0]?.id ?? "" };
}

describe("pickPaneContextProject", () => {
  it("命中本窗格内其它终端标签指向的项目", () => {
    const ws = workspace(["D:\\repos\\alpha", "D:\\repos\\beta"]);
    const pane = panel([
      tab({ projectPath: "" }),
      tab({ projectPath: "D:\\repos\\beta", projectId: "p-1" }),
    ]);

    expect(pickPaneContextProject(ws, pane)?.id).toBe("p-1");
  });

  it("跨路径形式等价（WSL /mnt 形式与 Windows 盘符视为同一项目）", () => {
    const ws = workspace(["D:\\repos\\alpha"]);
    const pane = panel([tab({ projectPath: "/mnt/d/repos/alpha" })]);

    expect(pickPaneContextProject(ws, pane)?.id).toBe("p-0");
  });

  it("没有窗格、没有终端标签、或项目不在该工作空间时返回 undefined", () => {
    const ws = workspace(["D:\\repos\\alpha"]);

    expect(pickPaneContextProject(ws, undefined)).toBeUndefined();
    expect(pickPaneContextProject(ws, panel([tab()]))).toBeUndefined();
    expect(
      pickPaneContextProject(ws, panel([tab({ projectPath: "D:\\repos\\other" })])),
    ).toBeUndefined();
    expect(
      pickPaneContextProject(
        ws,
        panel([tab({ contentType: "browser", projectPath: "D:\\repos\\alpha" })]),
      ),
    ).toBeUndefined();
  });
});
