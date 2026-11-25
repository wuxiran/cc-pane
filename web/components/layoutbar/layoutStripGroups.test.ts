import { describe, expect, it } from "vitest";
import { createPanel } from "@/lib/paneTree";
import type { LayoutEntry } from "@/types";
import { buildLayoutStripEntries, groupLayoutsByWorkspace } from "./layoutStripGroups";

function layout(id: string, workspaceName?: string): LayoutEntry {
  const rootPane = createPanel();
  return { id, name: id, kind: "normal", rootPane, activePaneId: rootPane.id, workspaceName };
}

function shape(entries: ReturnType<typeof buildLayoutStripEntries>) {
  return entries.map((entry) => entry.type === "group"
    ? `[${entry.group.key}${entry.group.collapsed ? "+" : ""}]`
    : entry.layout.id);
}

const layouts = [layout("a", "fe"), layout("b"), layout("c", "be"), layout("d", "fe"), layout("e", "fe")];

describe("buildLayoutStripEntries", () => {
  it("≥2 个布局的工作空间成组：组头在第一个成员处，成员连续排列；单个的不成组", () => {
    const entries = buildLayoutStripEntries(layouts, { currentLayoutId: "b", collapsedGroups: [] });
    expect(shape(entries)).toEqual(["[fe]", "a", "d", "e", "b", "c"]);
  });

  it("折叠的组只剩组头，当前布局在组里时仍紧跟组头", () => {
    expect(shape(buildLayoutStripEntries(layouts, { currentLayoutId: "b", collapsedGroups: ["fe"] })))
      .toEqual(["[fe+]", "b", "c"]);
    expect(shape(buildLayoutStripEntries(layouts, { currentLayoutId: "d", collapsedGroups: ["fe"] })))
      .toEqual(["[fe+]", "d", "b", "c"]);
  });
});

describe("groupLayoutsByWorkspace", () => {
  it("按工作空间分段，未绑定的放最后", () => {
    expect(groupLayoutsByWorkspace(layouts, "a").map((section) => [section.key, section.members.map((item) => item.id)]))
      .toEqual([["fe", ["a", "d", "e"]], ["be", ["c"]], [null, ["b"]]]);
  });
});
