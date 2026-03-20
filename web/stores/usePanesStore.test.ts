import { describe, it, expect, beforeEach } from "vitest";
import { usePanesStore } from "./usePanesStore";
import { createPanel } from "./paneTreeHelpers";
import {
  resetTestDataCounter,
} from "@/test/utils/testData";
import type { Panel, SplitPane } from "@/types";

describe("usePanesStore", () => {
  beforeEach(() => {
    resetTestDataCounter();
    const initialPanel = createPanel();
    usePanesStore.setState({
      rootPane: initialPanel,
      activePaneId: initialPanel.id,
      closedTabs: [],
    });
  });

  // ========== 派生方法 ==========

  describe("allPanels", () => {
    it("单面板应返回 1 个面板", () => {
      const panels = usePanesStore.getState().allPanels();
      expect(panels).toHaveLength(1);
      expect(panels[0].type).toBe("panel");
    });

    it("分屏后应返回 2 个面板", () => {
      const { rootPane, splitRight } = usePanesStore.getState();
      splitRight(rootPane.id);

      const panels = usePanesStore.getState().allPanels();
      expect(panels).toHaveLength(2);
    });
  });

  describe("activePane", () => {
    it("应返回当前活动面板", () => {
      const active = usePanesStore.getState().activePane();
      expect(active).not.toBeNull();
      expect(active!.type).toBe("panel");
      expect(active!.id).toBe(usePanesStore.getState().activePaneId);
    });
  });

  describe("findPaneById", () => {
    it("找到面板时应返回节点", () => {
      const { rootPane, findPaneById } = usePanesStore.getState();
      const found = findPaneById(rootPane.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(rootPane.id);
    });

    it("找不到面板时应返回 null", () => {
      const found = usePanesStore.getState().findPaneById("non-existent");
      expect(found).toBeNull();
    });
  });

  // ========== 分屏操作 ==========

  describe("splitRight", () => {
    it("应将 rootPane 变为水平分割并包含 2 个子面板", () => {
      const { rootPane, splitRight } = usePanesStore.getState();
      splitRight(rootPane.id);

      const state = usePanesStore.getState();
      expect(state.rootPane.type).toBe("split");
      const split = state.rootPane as SplitPane;
      expect(split.direction).toBe("horizontal");
      expect(split.children).toHaveLength(2);
      expect(split.sizes).toEqual([50, 50]);
    });
  });

  describe("splitDown", () => {
    it("应将 rootPane 变为垂直分割", () => {
      const { rootPane, splitDown } = usePanesStore.getState();
      splitDown(rootPane.id);

      const state = usePanesStore.getState();
      expect(state.rootPane.type).toBe("split");
      const split = state.rootPane as SplitPane;
      expect(split.direction).toBe("vertical");
      expect(split.children).toHaveLength(2);
    });
  });

  describe("closePane", () => {
    it("关闭分屏中的一个面板后应保留退化 SplitPane（避免 remount）", () => {
      const { rootPane, splitRight } = usePanesStore.getState();
      const originalPanelId = rootPane.id;
      splitRight(rootPane.id);

      const panels = usePanesStore.getState().allPanels();
      expect(panels).toHaveLength(2);

      // 关闭第二个面板（新建的那个，即活动面板）
      const activePaneId = usePanesStore.getState().activePaneId;
      usePanesStore.getState().closePane(activePaneId);

      const stateAfter = usePanesStore.getState();
      // 保留退化 SplitPane（不折叠），避免存活终端 remount
      expect(stateAfter.rootPane.type).toBe("split");
      const split = stateAfter.rootPane as SplitPane;
      expect(split.children).toHaveLength(1);
      expect(split.children[0].id).toBe(originalPanelId);
      // activePaneId 应指向存活面板
      expect(stateAfter.activePaneId).toBe(originalPanelId);
    });

    it("关闭根面板应重置为新空面板", () => {
      const { rootPane, closePane } = usePanesStore.getState();
      const originalId = rootPane.id;
      closePane(rootPane.id);

      const state = usePanesStore.getState();
      expect(state.rootPane.type).toBe("panel");
      expect(state.rootPane.id).not.toBe(originalId);
    });

    it("关闭面板时应保存可恢复标签到 closedTabs", () => {
      // 先给当前面板添加一个有 projectPath 的终端标签
      const state = usePanesStore.getState();
      const paneId = state.rootPane.id;
      state.addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/project1" });

      // 关闭面板
      usePanesStore.getState().closePane(paneId);

      const closedTabs = usePanesStore.getState().closedTabs;
      // 默认标签没有 projectPath（空字符串），但新添加的有
      expect(closedTabs.length).toBeGreaterThanOrEqual(1);
      expect(closedTabs.some((t) => t.projectPath === "/tmp/project1")).toBe(true);
    });
  });

  describe("resizePanes", () => {
    it("应更新 split 的 sizes 数组", () => {
      const { rootPane, splitRight } = usePanesStore.getState();
      splitRight(rootPane.id);

      const splitId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().resizePanes(splitId, [30, 70]);

      const split = usePanesStore.getState().rootPane as SplitPane;
      expect(split.sizes).toEqual([30, 70]);
    });
  });

  // ========== 标签操作 ==========

  describe("addTab", () => {
    it("应增加 tab 数量并设为活动标签", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      const tabsBefore = (usePanesStore.getState().rootPane as Panel).tabs.length;

      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });

      const pane = usePanesStore.getState().rootPane as Panel;
      expect(pane.tabs.length).toBe(tabsBefore + 1);
      expect(pane.activeTabId).toBe(pane.tabs[pane.tabs.length - 1].id);
    });
  });

  describe("closeTab", () => {
    it("多 tab 面板应移除 tab 并更新 activeTabId", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });
      usePanesStore.getState().addTab(paneId, { projectId: "proj-2", projectPath: "/tmp/proj2" });

      const pane = usePanesStore.getState().rootPane as Panel;
      expect(pane.tabs).toHaveLength(3);

      const tabToClose = pane.tabs[1];
      usePanesStore.getState().closeTab(paneId, tabToClose.id);

      const paneAfter = usePanesStore.getState().rootPane as Panel;
      expect(paneAfter.tabs).toHaveLength(2);
      expect(paneAfter.tabs.find((t) => t.id === tabToClose.id)).toBeUndefined();
    });

    it("单 tab 面板应触发 closePane", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      const tab = (usePanesStore.getState().rootPane as Panel).tabs[0];

      usePanesStore.getState().closeTab(paneId, tab.id);

      // closePane 对根面板会创建新面板
      const state = usePanesStore.getState();
      expect(state.rootPane.type).toBe("panel");
      expect(state.rootPane.id).not.toBe(paneId);
    });

    it("pinned tab 不可关闭", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });

      const pane = usePanesStore.getState().rootPane as Panel;
      const tabId = pane.tabs[0].id;

      // 先 pin 该 tab
      usePanesStore.getState().togglePinTab(paneId, tabId);
      // 尝试关闭
      usePanesStore.getState().closeTab(paneId, tabId);

      const paneAfter = usePanesStore.getState().rootPane as Panel;
      expect(paneAfter.tabs.find((t) => t.id === tabId)).toBeDefined();
    });

    it("关闭终端标签时应保存到 closedTabs", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });
      usePanesStore.getState().addTab(paneId, { projectId: "proj-2", projectPath: "/tmp/proj2" });

      const pane = usePanesStore.getState().rootPane as Panel;
      // 关闭第二个 tab（有 projectPath 的终端标签）
      const tabToClose = pane.tabs[1];
      usePanesStore.getState().closeTab(paneId, tabToClose.id);

      const closedTabs = usePanesStore.getState().closedTabs;
      expect(closedTabs).toHaveLength(1);
      expect(closedTabs[0].projectPath).toBe(tabToClose.projectPath);
    });
  });

  describe("togglePinTab", () => {
    it("应切换 pinned 状态", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      const tabId = (usePanesStore.getState().rootPane as Panel).tabs[0].id;

      usePanesStore.getState().togglePinTab(paneId, tabId);
      let tab = (usePanesStore.getState().rootPane as Panel).tabs[0];
      expect(tab.pinned).toBe(true);

      usePanesStore.getState().togglePinTab(paneId, tabId);
      tab = (usePanesStore.getState().rootPane as Panel).tabs[0];
      expect(tab.pinned).toBe(false);
    });
  });

  describe("renameTab", () => {
    it("应更新 title", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      const tabId = (usePanesStore.getState().rootPane as Panel).tabs[0].id;

      usePanesStore.getState().renameTab(paneId, tabId, "新名称");

      const tab = (usePanesStore.getState().rootPane as Panel).tabs[0];
      expect(tab.title).toBe("新名称");
    });
  });

  describe("reorderTabs", () => {
    it("应改变 tab 顺序", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });
      usePanesStore.getState().addTab(paneId, { projectId: "proj-2", projectPath: "/tmp/proj2" });

      const paneBefore = usePanesStore.getState().rootPane as Panel;
      const firstTabId = paneBefore.tabs[0].id;
      const lastTabId = paneBefore.tabs[2].id;

      usePanesStore.getState().reorderTabs(paneId, 0, 2);

      const paneAfter = usePanesStore.getState().rootPane as Panel;
      expect(paneAfter.tabs[2].id).toBe(firstTabId);
      expect(paneAfter.tabs[1].id).toBe(lastTabId);
    });
  });

  describe("moveTab", () => {
    it("应跨面板移动 tab", () => {
      const { rootPane, splitRight } = usePanesStore.getState();
      const firstPaneId = rootPane.id;

      // 在第一个面板添加额外 tab
      usePanesStore.getState().addTab(firstPaneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });

      splitRight(firstPaneId);

      const panels = usePanesStore.getState().allPanels();
      const secondPaneId = panels.find((p) => p.id !== firstPaneId)!.id;

      // 获取第一个面板的第一个 tab
      const firstPanel = panels.find((p) => p.id === firstPaneId) as Panel;
      const tabToMove = firstPanel.tabs[0].id;

      usePanesStore.getState().moveTab(firstPaneId, secondPaneId, tabToMove);

      const panelsAfter = usePanesStore.getState().allPanels();
      const fromPane = panelsAfter.find((p) => p.id === firstPaneId) as Panel;
      const toPane = panelsAfter.find((p) => p.id === secondPaneId) as Panel;

      expect(fromPane.tabs.find((t) => t.id === tabToMove)).toBeUndefined();
      expect(toPane.tabs.find((t) => t.id === tabToMove)).toBeDefined();
    });
  });

  describe("minimizeTab", () => {
    it("应将 tab 设为 minimized 并切换活动标签", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });

      const pane = usePanesStore.getState().rootPane as Panel;
      const firstTabId = pane.tabs[0].id;
      const secondTabId = pane.tabs[1].id;

      // 选中第一个 tab，然后最小化它
      usePanesStore.getState().selectTab(paneId, firstTabId);
      usePanesStore.getState().minimizeTab(paneId, firstTabId);

      const paneAfter = usePanesStore.getState().rootPane as Panel;
      const minimizedTab = paneAfter.tabs.find((t) => t.id === firstTabId)!;
      expect(minimizedTab.minimized).toBe(true);
      // 活动标签应切换到第二个
      expect(paneAfter.activeTabId).toBe(secondTabId);
    });
  });

  describe("restoreTab", () => {
    it("应恢复 minimized 状态并设为活动标签", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });

      const pane = usePanesStore.getState().rootPane as Panel;
      const firstTabId = pane.tabs[0].id;

      // 最小化后恢复
      usePanesStore.getState().minimizeTab(paneId, firstTabId);
      usePanesStore.getState().restoreTab(paneId, firstTabId);

      const paneAfter = usePanesStore.getState().rootPane as Panel;
      const restoredTab = paneAfter.tabs.find((t) => t.id === firstTabId)!;
      expect(restoredTab.minimized).toBe(false);
      expect(paneAfter.activeTabId).toBe(firstTabId);
    });
  });

  describe("selectTab", () => {
    it("应更新 activeTabId 和 activePaneId", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });

      const pane = usePanesStore.getState().rootPane as Panel;
      const firstTabId = pane.tabs[0].id;

      usePanesStore.getState().selectTab(paneId, firstTabId);

      const stateAfter = usePanesStore.getState();
      expect((stateAfter.rootPane as Panel).activeTabId).toBe(firstTabId);
      expect(stateAfter.activePaneId).toBe(paneId);
    });
  });

  describe("setActivePane", () => {
    it("应更新 activePaneId", () => {
      usePanesStore.getState().setActivePane("custom-pane-id");
      expect(usePanesStore.getState().activePaneId).toBe("custom-pane-id");
    });
  });

  describe("updateTabSession", () => {
    it("应更新 tab 的 sessionId", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      const tabId = (usePanesStore.getState().rootPane as Panel).tabs[0].id;

      usePanesStore.getState().updateTabSession(paneId, tabId, "session-123");

      const tab = (usePanesStore.getState().rootPane as Panel).tabs[0];
      expect(tab.sessionId).toBe("session-123");
    });
  });

  // ========== 项目打开 ==========

  describe("openProjectInPane", () => {
    it("无 resumeId 时应复用已有同 projectId 的 tab", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });

      const pane = usePanesStore.getState().rootPane as Panel;
      const existingTabId = pane.tabs.find((t) => t.projectId === "proj-1")!.id;

      usePanesStore.getState().openProjectInPane(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });

      const paneAfter = usePanesStore.getState().rootPane as Panel;
      // 不应创建新 tab
      expect(paneAfter.tabs.filter((t) => t.projectId === "proj-1")).toHaveLength(1);
      expect(paneAfter.activeTabId).toBe(existingTabId);
    });

    it("有 resumeId 时应总是新建 tab", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });

      const tabCountBefore = (usePanesStore.getState().rootPane as Panel).tabs.length;

      usePanesStore.getState().openProjectInPane(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1", resumeId: "resume-1" });

      const paneAfter = usePanesStore.getState().rootPane as Panel;
      expect(paneAfter.tabs.length).toBe(tabCountBefore + 1);
    });

    it("无 projectPath 的活动 tab 应被替换", () => {
      // 初始面板有一个默认 tab，其 projectPath 为 ""
      const paneId = usePanesStore.getState().rootPane.id;
      const pane = usePanesStore.getState().rootPane as Panel;
      const originalTabCount = pane.tabs.length;

      usePanesStore.getState().openProjectInPane(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });

      const paneAfter = usePanesStore.getState().rootPane as Panel;
      // tab 数量不变（替换了空标签）
      expect(paneAfter.tabs.length).toBe(originalTabCount);
      expect(paneAfter.tabs[0].projectId).toBe("proj-1");
    });
  });

  describe("openProject", () => {
    it("应委托给 openProjectInPane 使用活动面板", () => {
      const activePaneId = usePanesStore.getState().activePaneId;

      usePanesStore.getState().openProject({ projectId: "proj-1", projectPath: "/tmp/proj1" });

      const pane = usePanesStore.getState().findPaneById(activePaneId) as Panel;
      expect(pane.tabs.some((t) => t.projectId === "proj-1")).toBe(true);
    });
  });

  // ========== 特殊标签打开 ==========

  describe("openMcpConfig", () => {
    it("应创建 mcp-config 类型的 tab", () => {
      usePanesStore.getState().openMcpConfig("/tmp/project", "MyProject");

      const pane = usePanesStore.getState().activePane()!;
      const mcpTab = pane.tabs.find((t) => t.contentType === "mcp-config");
      expect(mcpTab).toBeDefined();
      expect(mcpTab!.title).toBe("MCP - MyProject");
      expect(mcpTab!.projectPath).toBe("/tmp/project");
    });

    it("重复打开应复用已有 tab", () => {
      usePanesStore.getState().openMcpConfig("/tmp/project", "MyProject");
      const tabCountAfterFirst = usePanesStore.getState().activePane()!.tabs.length;

      usePanesStore.getState().openMcpConfig("/tmp/project", "MyProject");
      const tabCountAfterSecond = usePanesStore.getState().activePane()!.tabs.length;

      expect(tabCountAfterSecond).toBe(tabCountAfterFirst);
    });
  });

  describe("openSkillManager", () => {
    it("应创建 skill-manager 类型的 tab", () => {
      usePanesStore.getState().openSkillManager("/tmp/project", "MyProject");

      const pane = usePanesStore.getState().activePane()!;
      const skillTab = pane.tabs.find((t) => t.contentType === "skill-manager");
      expect(skillTab).toBeDefined();
      expect(skillTab!.title).toBe("Skill - MyProject");
    });

    it("重复打开应复用已有 tab", () => {
      usePanesStore.getState().openSkillManager("/tmp/project", "MyProject");
      const count1 = usePanesStore.getState().activePane()!.tabs.length;

      usePanesStore.getState().openSkillManager("/tmp/project", "MyProject");
      const count2 = usePanesStore.getState().activePane()!.tabs.length;

      expect(count2).toBe(count1);
    });
  });

  describe("openMemoryManager", () => {
    it("应创建 memory-manager 类型的 tab", () => {
      usePanesStore.getState().openMemoryManager("/tmp/project", "MyProject");

      const pane = usePanesStore.getState().activePane()!;
      const memTab = pane.tabs.find((t) => t.contentType === "memory-manager");
      expect(memTab).toBeDefined();
      expect(memTab!.title).toBe("Memory - MyProject");
    });

    it("重复打开应复用已有 tab", () => {
      usePanesStore.getState().openMemoryManager("/tmp/project", "MyProject");
      const count1 = usePanesStore.getState().activePane()!.tabs.length;

      usePanesStore.getState().openMemoryManager("/tmp/project", "MyProject");
      const count2 = usePanesStore.getState().activePane()!.tabs.length;

      expect(count2).toBe(count1);
    });
  });

  // ========== 标签导航 ==========

  describe("reopenClosedTab", () => {
    it("应从 closedTabs 恢复标签", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });
      usePanesStore.getState().addTab(paneId, { projectId: "proj-2", projectPath: "/tmp/proj2" });

      // 关闭一个 tab
      const pane = usePanesStore.getState().rootPane as Panel;
      const tabToClose = pane.tabs[1];
      usePanesStore.getState().closeTab(paneId, tabToClose.id);

      expect(usePanesStore.getState().closedTabs).toHaveLength(1);

      // 恢复
      usePanesStore.getState().reopenClosedTab(paneId);

      const paneAfter = usePanesStore.getState().rootPane as Panel;
      // 恢复的标签应出现在面板中
      expect(paneAfter.tabs.some((t) => t.projectPath === tabToClose.projectPath)).toBe(true);
      expect(usePanesStore.getState().closedTabs).toHaveLength(0);
    });

    it("无已关闭标签时应无操作", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      const tabCountBefore = (usePanesStore.getState().rootPane as Panel).tabs.length;

      usePanesStore.getState().reopenClosedTab(paneId);

      const tabCountAfter = (usePanesStore.getState().rootPane as Panel).tabs.length;
      expect(tabCountAfter).toBe(tabCountBefore);
    });
  });

  describe("nextTab", () => {
    it("应循环切换到下一个标签", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });
      usePanesStore.getState().addTab(paneId, { projectId: "proj-2", projectPath: "/tmp/proj2" });

      const pane = usePanesStore.getState().rootPane as Panel;
      const firstTabId = pane.tabs[0].id;

      // 选中第一个 tab
      usePanesStore.getState().selectTab(paneId, firstTabId);
      // 切换到下一个
      usePanesStore.getState().nextTab(paneId);

      const paneAfter = usePanesStore.getState().rootPane as Panel;
      expect(paneAfter.activeTabId).toBe(pane.tabs[1].id);
    });

    it("最后一个标签时应循环到第一个", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });

      const pane = usePanesStore.getState().rootPane as Panel;
      const lastTabId = pane.tabs[pane.tabs.length - 1].id;
      const firstTabId = pane.tabs[0].id;

      usePanesStore.getState().selectTab(paneId, lastTabId);
      usePanesStore.getState().nextTab(paneId);

      const paneAfter = usePanesStore.getState().rootPane as Panel;
      expect(paneAfter.activeTabId).toBe(firstTabId);
    });
  });

  describe("prevTab", () => {
    it("应反向循环切换到上一个标签", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });
      usePanesStore.getState().addTab(paneId, { projectId: "proj-2", projectPath: "/tmp/proj2" });

      const pane = usePanesStore.getState().rootPane as Panel;
      const secondTabId = pane.tabs[1].id;
      const firstTabId = pane.tabs[0].id;

      usePanesStore.getState().selectTab(paneId, secondTabId);
      usePanesStore.getState().prevTab(paneId);

      const paneAfter = usePanesStore.getState().rootPane as Panel;
      expect(paneAfter.activeTabId).toBe(firstTabId);
    });

    it("第一个标签时应循环到最后一个", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });

      const pane = usePanesStore.getState().rootPane as Panel;
      const firstTabId = pane.tabs[0].id;
      const lastTabId = pane.tabs[pane.tabs.length - 1].id;

      usePanesStore.getState().selectTab(paneId, firstTabId);
      usePanesStore.getState().prevTab(paneId);

      const paneAfter = usePanesStore.getState().rootPane as Panel;
      expect(paneAfter.activeTabId).toBe(lastTabId);
    });
  });

  describe("switchToTab", () => {
    it("应切换到指定索引的标签", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1" });
      usePanesStore.getState().addTab(paneId, { projectId: "proj-2", projectPath: "/tmp/proj2" });

      const pane = usePanesStore.getState().rootPane as Panel;
      const targetTabId = pane.tabs[1].id;

      usePanesStore.getState().switchToTab(paneId, 1);

      const paneAfter = usePanesStore.getState().rootPane as Panel;
      expect(paneAfter.activeTabId).toBe(targetTabId);
    });

    it("索引越界时应无操作", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      const activeTabBefore = (usePanesStore.getState().rootPane as Panel).activeTabId;

      usePanesStore.getState().switchToTab(paneId, 99);

      const activeTabAfter = (usePanesStore.getState().rootPane as Panel).activeTabId;
      expect(activeTabAfter).toBe(activeTabBefore);
    });

    it("负数索引时应无操作", () => {
      const paneId = usePanesStore.getState().rootPane.id;
      const activeTabBefore = (usePanesStore.getState().rootPane as Panel).activeTabId;

      usePanesStore.getState().switchToTab(paneId, -1);

      const activeTabAfter = (usePanesStore.getState().rootPane as Panel).activeTabId;
      expect(activeTabAfter).toBe(activeTabBefore);
    });
  });
});
