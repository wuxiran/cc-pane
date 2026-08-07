import { describe, expect, it } from "vitest";

import { TAB_CONTENT_GROUP, type TabContentType } from "@/lib/tabContentType";
import { inferCliTool, resolveRestoreMode } from "@/lib/terminalRestoreMode";
import { TAB_LIFECYCLE } from "./registry";
import { createTabOfType } from "./tabFactory";
import type { Tab } from "@/types";
import type { CreateTabOptions } from "@/stores/panesStoreTypes";

const ALL_CONTENT_TYPES = Object.keys(TAB_CONTENT_GROUP) as TabContentType[];

/** 改道前 usePanesStore.createTab 的字面量（逐字节抄写，作为对照基准）。 */
function legacyTerminalTab(opts: CreateTabOptions, ids: { tab: string; leaf: string; launch: string }): Tab {
  const { projectId, projectPath, resumeId, cliTool, customTitle, ssh, wsl, machineName } = opts;
  let title: string;
  if (customTitle) {
    title = customTitle;
  } else {
    const name = projectPath.split(/[/\\]/).pop() || "Terminal";
    if (ssh) {
      title = `[${machineName || "SSH"}] ${name}`;
    } else if (wsl && cliTool && cliTool !== "none") {
      title = `${name} (${cliTool.charAt(0).toUpperCase() + cliTool.slice(1)} WSL)`;
    } else if (cliTool && cliTool !== "none") {
      title = `${name} (${cliTool.charAt(0).toUpperCase() + cliTool.slice(1)})`;
    } else if (resumeId === "new") {
      title = `${name} (Claude)`;
    } else if (resumeId) {
      title = `${name} (resume)`;
    } else {
      title = name;
    }
  }
  const leaf = {
    type: "leaf" as const,
    id: ids.leaf,
    launchId: opts.launchId ?? ids.launch,
    restoreMode: resolveRestoreMode({ cliTool: inferCliTool(cliTool, resumeId), resumeId }),
    sessionId: opts.sessionId ?? null,
    resumeId,
    workspaceName: opts.workspaceName,
    providerId: opts.providerId,
    modelId: opts.modelId,
    providerSelection: opts.providerSelection,
    launchProfileId: opts.launchProfileId,
    workspacePath: opts.workspacePath,
    workspaceSnapshotId: opts.workspaceSnapshotId,
    cliTool,
    launchClaude: (cliTool && cliTool !== "none") || undefined,
    ssh,
    wsl,
    machineName,
    launchExtras: opts.launchExtras,
  };
  return {
    id: ids.tab,
    title,
    contentType: "terminal",
    projectId,
    projectPath,
    sessionId: leaf.sessionId,
    resumeId: leaf.resumeId,
    workspaceName: leaf.workspaceName,
    providerId: leaf.providerId,
    modelId: leaf.modelId,
    providerSelection: leaf.providerSelection,
    launchProfileId: leaf.launchProfileId,
    workspacePath: leaf.workspacePath,
    workspaceSnapshotId: leaf.workspaceSnapshotId,
    cliTool: leaf.cliTool,
    launchClaude: leaf.launchClaude,
    ssh: leaf.ssh,
    wsl: leaf.wsl,
    machineName: leaf.machineName,
    terminalRootPane: leaf,
    activeTerminalPaneId: leaf.id,
    parentTabId: opts.parentTabId,
    launchExtras: leaf.launchExtras,
  };
}

function terminalIds(tab: Tab) {
  const leaf = tab.terminalRootPane;
  if (!leaf || leaf.type !== "leaf") throw new Error("expected leaf root");
  return { tab: tab.id, leaf: leaf.id, launch: leaf.launchId ?? "" };
}

describe("createTabOfType", () => {
  it("每种 contentType 都登记了 createDefaults", () => {
    for (const contentType of ALL_CONTENT_TYPES) {
      expect(typeof TAB_LIFECYCLE[contentType].createDefaults).toBe("function");
    }
  });

  it("公共底座字段对每种 contentType 都成立", () => {
    for (const contentType of ALL_CONTENT_TYPES) {
      const tab = createTabOfType(contentType, { projectPath: "/p", title: "T" });
      expect(tab.contentType).toBe(contentType);
      expect(tab.id).toMatch(/^tab-/);
      expect(tab.projectPath).toBe("/p");
      expect(tab.projectId).toBe("");
    }
  });

  it("调用方指定 id 时不再生成（browser webview 键与 tabId 同源）", () => {
    const tab = createTabOfType("browser", { id: "tab-fixed", browserUrl: "https://x.dev" });
    expect(tab.id).toBe("tab-fixed");
  });

  // 逐字段快照相等：工厂输出必须与改道前的字面量一字不差（ids 对齐后）。
  const cases: Array<[string, CreateTabOptions]> = [
    ["纯 shell", { projectId: "p1", projectPath: "/a/b/demo" }],
    ["claude 新会话", { projectId: "p1", projectPath: "/a/b/demo", cliTool: "claude", resumeId: "new" }],
    ["resume", { projectId: "p1", projectPath: "/a/b/demo", cliTool: "claude", resumeId: "sess-1" }],
    ["ssh", { projectId: "p1", projectPath: "/a/b/demo", ssh: { host: "h", user: "u", port: 22, remotePath: "/home/u" }, machineName: "box" }],
    [
      "wsl codex",
      {
        projectId: "p1",
        projectPath: "/a/b/demo",
        cliTool: "codex",
        wsl: { distro: "Ubuntu", remotePath: "/mnt/d/demo" },
        launchExtras: { initialPrompt: "hi" },
        parentTabId: "tab-parent",
      },
    ],
    ["customTitle", { projectId: "p1", projectPath: "/a/b/demo", customTitle: "我的标签" }],
  ];

  it.each(cases)("terminal 工厂输出与原字面量逐字段相等：%s", (_name, opts) => {
    const tab = createTabOfType("terminal", {
      projectId: opts.projectId,
      projectPath: opts.projectPath,
      terminal: opts,
    });
    expect(tab).toEqual(legacyTerminalTab(opts, terminalIds(tab)));
  });

  it("launchId 每次构造都新生成（docs/69：复用会让 resume id 落库落空）", () => {
    const opts: CreateTabOptions = { projectId: "p1", projectPath: "/a/b/demo", cliTool: "claude" };
    const seen = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      const tab = createTabOfType("terminal", { terminal: opts, projectPath: opts.projectPath });
      const leaf = tab.terminalRootPane;
      if (!leaf || leaf.type !== "leaf") throw new Error("expected leaf root");
      expect(leaf.launchId).toBeTruthy();
      expect(seen.has(leaf.launchId as string)).toBe(false);
      seen.add(leaf.launchId as string);
    }
  });

  // 6 处内联字面量改道的对照（docs/78 批4「逐处 diff，不顺手统一」）：
  // 每处的原字面量按当时源码逐字抄在这里，工厂输出必须与之逐字段相等。
  describe("改道的 6 处内联字面量", () => {
    it("openMcpConfig / openSkillManager / openMemoryManager / openFileExplorer", () => {
      const sites: Array<[TabContentType, string]> = [
        ["mcp-config", "MCP"],
        ["skill-manager", "Skill"],
        ["memory-manager", "Memory"],
        ["file-explorer", "Explorer"],
      ];
      for (const [contentType, prefix] of sites) {
        const title = `${prefix} - demo`;
        const tab = createTabOfType(contentType, { title, projectPath: "/a/b/demo" });
        expect(tab).toEqual({
          id: tab.id,
          title,
          contentType,
          projectId: "",
          projectPath: "/a/b/demo",
          sessionId: null,
        });
      }
    });

    it("openBrowser：调用方 id 与标题兜底都保留", () => {
      const withId = createTabOfType("browser", {
        id: "tab-caller",
        title: "  站点  ",
        browserUrl: "https://x.dev",
      });
      expect(withId).toEqual({
        id: "tab-caller",
        title: "站点",
        contentType: "browser",
        projectId: "",
        projectPath: "",
        sessionId: null,
        browserUrl: "https://x.dev",
      });

      const noTitle = createTabOfType("browser", { browserUrl: "https://x.dev" });
      expect(noTitle.title).toBe("Browser");
      expect(noTitle.id).toMatch(/^tab-/);
    });

    it("openEditor：filePath 与 projectPath 落在 tab 上", () => {
      const tab = createTabOfType("editor", {
        title: "main.rs",
        projectPath: "/a/b/demo",
        filePath: "/a/b/demo/src/main.rs",
      });
      expect(tab).toEqual({
        id: tab.id,
        title: "main.rs",
        contentType: "editor",
        projectId: "",
        projectPath: "/a/b/demo",
        sessionId: null,
        filePath: "/a/b/demo/src/main.rs",
      });
    });
  });

  it("显式传入 launchId 时沿用（PTY 先建、标签后开的入口）", () => {
    const tab = createTabOfType("terminal", {
      terminal: { projectId: "p1", projectPath: "/a", launchId: "launch-fixed", sessionId: "sess-9" },
    });
    const leaf = tab.terminalRootPane;
    expect(leaf?.type === "leaf" ? leaf.launchId : null).toBe("launch-fixed");
    expect(tab.sessionId).toBe("sess-9");
  });
});
