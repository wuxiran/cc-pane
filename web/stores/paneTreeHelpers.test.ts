import { describe, it, expect } from "vitest";
import type { Panel, SplitPane, PaneNode } from "@/types";
import {
  generateId,
  createPanel,
  createTab,
  findPane,
  findParent,
  collectPanels,
} from "./paneTreeHelpers";

describe("generateId", () => {
  it("生成格式为 prefix-UUID 的字符串", () => {
    const id = generateId("pane");
    expect(id).toMatch(/^pane-.+$/);
  });

  it("不同前缀生成对应格式", () => {
    const id = generateId("tab");
    expect(id).toMatch(/^tab-.+$/);
  });

  it("两次调用返回不同值", () => {
    const id1 = generateId("pane");
    const id2 = generateId("pane");
    expect(id1).not.toBe(id2);
  });
});

describe("createPanel", () => {
  it("无参数时创建带默认 Tab 的 Panel", () => {
    const panel = createPanel();
    expect(panel.type).toBe("panel");
    expect(panel.tabs).toHaveLength(1);
    expect(panel.tabs[0].title).toBe("Terminal");
    expect(panel.tabs[0].contentType).toBe("terminal");
    expect(panel.tabs[0].projectId).toBe("");
    expect(panel.tabs[0].projectPath).toBe("");
    expect(panel.tabs[0].sessionId).toBeNull();
    expect(panel.activeTabId).toBe(panel.tabs[0].id);
  });

  it("传入 Tab 时使用传入的 Tab", () => {
    const customTab = {
      id: "custom-tab-1",
      title: "My Tab",
      contentType: "terminal" as const,
      projectId: "proj-1",
      projectPath: "/home/user/project",
      sessionId: null,
    };
    const panel = createPanel(customTab);
    expect(panel.type).toBe("panel");
    expect(panel.tabs).toHaveLength(1);
    expect(panel.tabs[0]).toBe(customTab);
    expect(panel.activeTabId).toBe("custom-tab-1");
  });

  it("type 始终为 panel", () => {
    expect(createPanel().type).toBe("panel");
    expect(
      createPanel({
        id: "t",
        title: "T",
        contentType: "terminal",
        projectId: "",
        projectPath: "",
        sessionId: null,
      }).type
    ).toBe("panel");
  });

  it("id 以 pane- 开头", () => {
    const panel = createPanel();
    expect(panel.id).toMatch(/^pane-.+$/);
  });
});

describe("createTab", () => {
  it("基本调用 - title 为路径最后一段", () => {
    const tab = createTab("proj-1", "/home/user/my-project");
    expect(tab.title).toBe("my-project");
    expect(tab.projectId).toBe("proj-1");
    expect(tab.projectPath).toBe("/home/user/my-project");
    expect(tab.contentType).toBe("terminal");
    expect(tab.sessionId).toBeNull();
    expect(tab.id).toMatch(/^tab-.+$/);
  });

  it("resumeId 为 'new' 时 title 为 'name (Claude)'", () => {
    const tab = createTab("proj-1", "/home/user/my-project", "new");
    expect(tab.title).toBe("my-project (Claude)");
    expect(tab.resumeId).toBe("new");
  });

  it("resumeId 为其他值时 title 为 'name (resume)'", () => {
    const tab = createTab("proj-1", "/home/user/my-project", "abc-123");
    expect(tab.title).toBe("my-project (resume)");
    expect(tab.resumeId).toBe("abc-123");
  });

  it("无 resumeId 时 title 为路径最后一段", () => {
    const tab = createTab("proj-1", "/home/user/my-project");
    expect(tab.title).toBe("my-project");
    expect(tab.resumeId).toBeUndefined();
  });

  it("反斜杠路径也能正确提取名称", () => {
    const tab = createTab("proj-1", "C:\\Users\\dev\\my-project");
    expect(tab.title).toBe("my-project");
  });

  it("传入 workspaceName 和 providerId", () => {
    const tab = createTab(
      "proj-1",
      "/home/user/project",
      "new",
      "ws-main",
      "provider-1"
    );
    expect(tab.workspaceName).toBe("ws-main");
    expect(tab.providerId).toBe("provider-1");
  });

  it("路径仅有名称时正确处理", () => {
    const tab = createTab("proj-1", "standalone");
    expect(tab.title).toBe("standalone");
  });

  it("空路径时 title 为 Terminal", () => {
    const tab = createTab("proj-1", "");
    // "".split(/[/\\]/) = [""], pop() = "", "" || "Terminal" = "Terminal"
    expect(tab.title).toBe("Terminal");
  });
});

// 辅助函数：创建测试用的面板树结构
function makePanel(id: string): Panel {
  return {
    type: "panel",
    id,
    tabs: [
      {
        id: `tab-${id}`,
        title: "Test",
        contentType: "terminal",
        projectId: "",
        projectPath: "",
        sessionId: null,
      },
    ],
    activeTabId: `tab-${id}`,
  };
}

function makeSplit(
  id: string,
  children: PaneNode[],
  direction: "horizontal" | "vertical" = "horizontal"
): SplitPane {
  return {
    type: "split",
    id,
    direction,
    children,
    sizes: children.map(() => 100 / children.length),
  };
}

describe("findPane", () => {
  it("在 Panel 中查找自身", () => {
    const panel = makePanel("p1");
    const found = findPane(panel, "p1");
    expect(found).toBe(panel);
  });

  it("在 SplitPane 中递归查找子节点", () => {
    const child1 = makePanel("p1");
    const child2 = makePanel("p2");
    const root = makeSplit("root", [child1, child2]);

    expect(findPane(root, "p1")).toBe(child1);
    expect(findPane(root, "p2")).toBe(child2);
    expect(findPane(root, "root")).toBe(root);
  });

  it("查找不存在的 id 返回 null", () => {
    const panel = makePanel("p1");
    expect(findPane(panel, "not-exist")).toBeNull();
  });

  it("查找不存在的 id - 在 SplitPane 中", () => {
    const root = makeSplit("root", [makePanel("p1"), makePanel("p2")]);
    expect(findPane(root, "not-exist")).toBeNull();
  });

  it("多层嵌套查找", () => {
    const deep = makePanel("deep");
    const mid = makeSplit("mid", [makePanel("p1"), deep]);
    const root = makeSplit("root", [mid, makePanel("p2")]);

    expect(findPane(root, "deep")).toBe(deep);
    expect(findPane(root, "mid")).toBe(mid);
    expect(findPane(root, "p1")).not.toBeNull();
    expect(findPane(root, "p2")).not.toBeNull();
  });

  it("三层嵌套查找最深节点", () => {
    const deepest = makePanel("deepest");
    const level2 = makeSplit("l2", [deepest]);
    const level1 = makeSplit("l1", [level2, makePanel("sibling")]);
    const root = makeSplit("root", [level1]);

    expect(findPane(root, "deepest")).toBe(deepest);
  });
});

describe("findParent", () => {
  it("根节点的 parent 为 null", () => {
    const panel = makePanel("p1");
    const result = findParent(panel, "p1");
    expect(result).not.toBeNull();
    expect(result!.parent).toBeNull();
    expect(result!.index).toBe(-1);
  });

  it("子节点返回其父 SplitPane 和 index", () => {
    const child1 = makePanel("p1");
    const child2 = makePanel("p2");
    const root = makeSplit("root", [child1, child2]);

    const result1 = findParent(root, "p1");
    expect(result1).not.toBeNull();
    expect(result1!.parent).toBe(root);
    expect(result1!.index).toBe(0);

    const result2 = findParent(root, "p2");
    expect(result2).not.toBeNull();
    expect(result2!.parent).toBe(root);
    expect(result2!.index).toBe(1);
  });

  it("不存在的 id 返回 null", () => {
    const root = makeSplit("root", [makePanel("p1")]);
    expect(findParent(root, "not-exist")).toBeNull();
  });

  it("多层嵌套中查找父节点", () => {
    const deep = makePanel("deep");
    const mid = makeSplit("mid", [makePanel("p1"), deep]);
    const root = makeSplit("root", [mid, makePanel("p2")]);

    const result = findParent(root, "deep");
    expect(result).not.toBeNull();
    expect(result!.parent).toBe(mid);
    expect(result!.index).toBe(1);
  });

  it("查找 SplitPane 子节点的父节点", () => {
    const mid = makeSplit("mid", [makePanel("p1")]);
    const root = makeSplit("root", [mid, makePanel("p2")]);

    const result = findParent(root, "mid");
    expect(result).not.toBeNull();
    expect(result!.parent).toBe(root);
    expect(result!.index).toBe(0);
  });
});

describe("collectPanels", () => {
  it("单个 Panel 返回包含该 Panel 的数组", () => {
    const panel = makePanel("p1");
    const panels = collectPanels(panel);
    expect(panels).toHaveLength(1);
    expect(panels[0]).toBe(panel);
  });

  it("SplitPane 展开所有 Panel", () => {
    const p1 = makePanel("p1");
    const p2 = makePanel("p2");
    const root = makeSplit("root", [p1, p2]);

    const panels = collectPanels(root);
    expect(panels).toHaveLength(2);
    expect(panels).toContain(p1);
    expect(panels).toContain(p2);
  });

  it("多层嵌套展平所有 Panel", () => {
    const p1 = makePanel("p1");
    const p2 = makePanel("p2");
    const p3 = makePanel("p3");
    const mid = makeSplit("mid", [p1, p2]);
    const root = makeSplit("root", [mid, p3]);

    const panels = collectPanels(root);
    expect(panels).toHaveLength(3);
    expect(panels).toContain(p1);
    expect(panels).toContain(p2);
    expect(panels).toContain(p3);
  });

  it("三层嵌套展平", () => {
    const p1 = makePanel("p1");
    const p2 = makePanel("p2");
    const p3 = makePanel("p3");
    const p4 = makePanel("p4");
    const deep = makeSplit("deep", [p1, p2]);
    const mid = makeSplit("mid", [deep, p3]);
    const root = makeSplit("root", [mid, p4]);

    const panels = collectPanels(root);
    expect(panels).toHaveLength(4);
    expect(panels).toContain(p1);
    expect(panels).toContain(p2);
    expect(panels).toContain(p3);
    expect(panels).toContain(p4);
  });

  it("保持展平后顺序（深度优先）", () => {
    const p1 = makePanel("p1");
    const p2 = makePanel("p2");
    const p3 = makePanel("p3");
    const left = makeSplit("left", [p1, p2]);
    const root = makeSplit("root", [left, p3]);

    const panels = collectPanels(root);
    expect(panels[0]).toBe(p1);
    expect(panels[1]).toBe(p2);
    expect(panels[2]).toBe(p3);
  });
});
