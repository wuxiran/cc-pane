// 内置命令清单的结构契约：关键命令存在、分组正确、项目依赖命令的 when 门禁。
import "@/i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePanesStore } from "@/stores";
import { TERMINAL_REBUILD_DISPLAY_EVENT } from "@/components/panes/terminalFitEvents";
import { buildBuiltinCommands } from "./builtinCommands";

function findCommand(id: string) {
  const cmd = buildBuiltinCommands().find((item) => item.id === id);
  if (!cmd) throw new Error(`command not registered: ${id}`);
  return cmd;
}

function setActiveTerminalTab(projectPath: string | null) {
  const tab = {
    id: "tab-1",
    title: "T",
    contentType: "terminal" as const,
    projectId: "proj-1",
    sessionId: null,
    projectPath: projectPath ?? "",
  };
  usePanesStore.setState({
    rootPane: { type: "panel", id: "pane-1", tabs: [tab], activeTabId: tab.id },
    activePaneId: "pane-1",
  });
}

beforeEach(() => {
  usePanesStore.setState({
    rootPane: { type: "panel", id: "pane-1", tabs: [], activeTabId: "" },
    activePaneId: "pane-1",
  });
});

describe("buildBuiltinCommands", () => {
  it("批 6 深埋功能命令全部注册且归 system 组", () => {
    for (const id of [
      "shortcut-cheatsheet",
      "screenshot-capture",
      "local-history",
      "worktree-manager",
      "git-timeline",
      "session-cleaner",
    ]) {
      expect(findCommand(id).group).toBe("system");
    }
  });

  it("批 2 布局命令归 layout 组，预设命令带 panes 文案", () => {
    for (const id of ["close-pane", "equalize-panes", "zoom-pane", "split-clone-tab"]) {
      expect(findCommand(id).group).toBe("layout");
    }
    const preset = findCommand("apply-preset-two-col");
    expect(preset.group).toBe("layout");
    expect(preset.titleNs).toBe("panes");
  });

  it("项目依赖命令：无项目路径时 when 拦截，有则放行", () => {
    setActiveTerminalTab(null);
    expect(findCommand("local-history").when?.({})).toBe(false);

    setActiveTerminalTab("D:/repo/demo");
    expect(findCommand("local-history").when?.({})).toBe(true);
    expect(findCommand("git-timeline").when?.({})).toBe(true);
  });

  it("zoom-pane 单 pane 布局时禁用", () => {
    expect(findCommand("zoom-pane").when?.({})).toBe(false);
  });

  it("重建终端画面：派发给激活分屏的会话，没有会话时不派发", () => {
    const listener = vi.fn();
    window.addEventListener(TERMINAL_REBUILD_DISPLAY_EVENT, listener);
    try {
      const leaf = (id: string, sessionId: string | null) => ({ type: "leaf" as const, id, sessionId });
      const tab = {
        id: "tab-1",
        title: "T",
        contentType: "terminal" as const,
        projectId: "proj-1",
        sessionId: "sess-a",
        projectPath: "",
        terminalRootPane: {
          type: "split", id: "split-1", direction: "horizontal", sizes: [50, 50],
          children: [leaf("leaf-a", "sess-a"), leaf("leaf-b", "sess-b")],
        },
        activeTerminalPaneId: "leaf-b",
      };
      usePanesStore.setState({
        rootPane: { type: "panel", id: "pane-1", tabs: [tab], activeTabId: tab.id },
        activePaneId: "pane-1",
      } as never);
      findCommand("terminal-rebuild-display").run({});
      expect(listener).toHaveBeenCalledTimes(1);
      expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: "sess-b" });

      setActiveTerminalTab(null);
      findCommand("terminal-rebuild-display").run({});
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(TERMINAL_REBUILD_DISPLAY_EVENT, listener);
    }
  });
});
