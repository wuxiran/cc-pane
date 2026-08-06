import { describe, expect, it } from "vitest";
import { createPanel } from "@/lib/paneTree";
import type { PaneNode, SplitPane, Tab } from "@/types";
import { deriveLayoutTypeSummary, nonEmptyGroups } from "./layoutTypeSummary";

function tab(id: string, contentType: Tab["contentType"]): Tab {
  return {
    id,
    title: id,
    contentType,
    projectId: "project-a",
    projectPath: "/work/cc-book",
    sessionId: null,
  };
}

function panelWith(...tabs: Tab[]) {
  const panel = createPanel();
  panel.tabs = tabs;
  return panel;
}

describe("deriveLayoutTypeSummary", () => {
  it("按四桁分组计数，total 等于全类型 tab 总数", () => {
    const rootPane = panelWith(
      tab("t1", "terminal"),
      tab("t2", "terminal"),
      tab("b1", "browser"),
      tab("e1", "editor"),
      tab("f1", "file-explorer"),
      tab("m1", "mcp-config"),
    );

    const summary = deriveLayoutTypeSummary(rootPane);
    expect(summary.groups.terminal).toHaveLength(2);
    expect(summary.groups.browser).toHaveLength(1);
    // editor + file-explorer 都归「文件」
    expect(summary.groups.files).toHaveLength(2);
    expect(summary.groups.tools).toHaveLength(1);
    // total 必须等于各桁之和——卡片顶部显示的就是它，对不上会让人以为丢了 tab
    expect(summary.total).toBe(6);
  });

  it("递归收集嵌套 split 下的所有面板，并带上导航所需的 paneId", () => {
    const left = panelWith(tab("t1", "terminal"));
    const right = panelWith(tab("b1", "browser"));
    const rootPane: SplitPane = {
      type: "split",
      id: "split-root",
      direction: "horizontal",
      children: [left, right],
      sizes: [50, 50],
    };

    const summary = deriveLayoutTypeSummary(rootPane);
    expect(summary.total).toBe(2);
    expect(summary.groups.terminal[0]).toEqual({ tabId: "t1", paneId: left.id, title: "t1" });
    expect(summary.groups.browser[0]).toEqual({ tabId: "b1", paneId: right.id, title: "b1" });
  });

  // starred 布局是镜像（panes/starredMirrors.ts），直接统计会把同一个 tab 数两遍
  it("starred 布局一律返回空，避免镜像重复计数", () => {
    const rootPane = panelWith(tab("t1", "terminal"), tab("b1", "browser"));
    const summary = deriveLayoutTypeSummary(rootPane, "starred");
    expect(summary.total).toBe(0);
    expect(nonEmptyGroups(summary)).toEqual([]);
  });

  it("空树给出全零且各桁为空数组（调用方无需判空）", () => {
    const empty = createPanel();
    empty.tabs = [];
    const summary = deriveLayoutTypeSummary(empty as PaneNode);
    expect(summary.total).toBe(0);
    expect(summary.groups.files).toEqual([]);
  });
});

describe("nonEmptyGroups", () => {
  it("只返回非空桁，且顺序固定为 终端 → 浏览器 → 文件 → 工具", () => {
    const rootPane = panelWith(
      tab("m1", "mcp-config"),
      tab("e1", "editor"),
      tab("t1", "terminal"),
    );
    // 刻意按 工具 → 文件 → 终端 的顺序放进去，输出仍要是固定顺序
    expect(nonEmptyGroups(deriveLayoutTypeSummary(rootPane)).map((g) => g.group)).toEqual([
      "terminal",
      "files",
      "tools",
    ]);
  });
});
