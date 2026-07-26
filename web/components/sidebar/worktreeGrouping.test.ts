import { describe, expect, it } from "vitest";
import type { WorktreeInfo } from "@/services";
import type { WorkspaceProject } from "@/types";
import { buildProjectTree, type ProjectTreeNode } from "./worktreeGrouping";

function project(id: string, path: string, extra: Partial<WorkspaceProject> = {}): WorkspaceProject {
  return { id, path, ...extra };
}

function entry(path: string, branch: string, isMain = false): WorktreeInfo {
  return { path, branch, commit: "abc1234", isMain };
}

const MAIN = "D:\\repo";
const WT_A = "D:\\repo-wt-a";
const WT_B = "D:\\repo-wt-b";

/** git worktree list 从任何一个 worktree 跑都返回同一份全量列表 */
const FULL_LIST: WorktreeInfo[] = [
  entry(MAIN, "main", true),
  entry(WT_A, "feature/a"),
  entry(WT_B, "feature/b"),
];

function singlePaths(nodes: ProjectTreeNode[]): string[] {
  return nodes.filter((n) => n.kind === "single").map((n) => n.project.path);
}

describe("buildProjectTree", () => {
  it("把 worktree 收进主仓库节点下", () => {
    const projects = [project("m", MAIN), project("a", WT_A), project("b", WT_B)];
    const nodes = buildProjectTree(projects, {
      [MAIN]: FULL_LIST,
      [WT_A]: FULL_LIST,
      [WT_B]: FULL_LIST,
    });

    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe("group");
    if (nodes[0].kind !== "group") return;
    expect(nodes[0].group.parent.id).toBe("m");
    expect(nodes[0].group.children.map((c) => c.project.id)).toEqual(["a", "b"]);
    expect(nodes[0].group.children.map((c) => c.branch)).toEqual(["feature/a", "feature/b"]);
  });

  // 核心防御：worktree 视角的全量列表不能把主仓库反向吞成自己的子节点
  it("worktree 不会反向吞掉主仓库", () => {
    const projects = [project("a", WT_A), project("m", MAIN)];
    const nodes = buildProjectTree(projects, { [WT_A]: FULL_LIST, [MAIN]: FULL_LIST });

    expect(nodes).toHaveLength(1);
    if (nodes[0].kind !== "group") throw new Error("expected group");
    expect(nodes[0].group.parent.id).toBe("m");
    expect(nodes[0].group.children.map((c) => c.project.id)).toEqual(["a"]);
  });

  it("任一项目不会同时出现在 parent 与 children（无环）", () => {
    const projects = [project("m", MAIN), project("a", WT_A), project("b", WT_B)];
    const nodes = buildProjectTree(projects, {
      [MAIN]: FULL_LIST,
      [WT_A]: FULL_LIST,
      [WT_B]: FULL_LIST,
    });
    const parents = new Set<string>();
    const children = new Set<string>();
    for (const node of nodes) {
      if (node.kind !== "group") continue;
      parents.add(node.group.parent.id);
      node.group.children.forEach((c) => children.add(c.project.id));
    }
    for (const id of parents) expect(children.has(id)).toBe(false);
  });

  it("主仓库未加入工作空间时全部保持平铺", () => {
    const projects = [project("a", WT_A), project("b", WT_B)];
    const nodes = buildProjectTree(projects, { [WT_A]: FULL_LIST, [WT_B]: FULL_LIST });

    expect(nodes.every((n) => n.kind === "single")).toBe(true);
    expect(singlePaths(nodes)).toEqual([WT_A, WT_B]);
  });

  it("主仓库无 worktree 时保持单节点", () => {
    const projects = [project("m", MAIN)];
    const nodes = buildProjectTree(projects, { [MAIN]: [entry(MAIN, "main", true)] });

    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe("single");
  });

  // 守卫：monorepo 子目录也能从 git 拿到同一个 main，但它不是 worktree 根
  it("repo 子目录项目不会被误认成 worktree", () => {
    const sub = "D:\\repo\\packages\\api";
    const projects = [project("m", MAIN), project("s", sub)];
    const nodes = buildProjectTree(projects, { [MAIN]: FULL_LIST, [sub]: FULL_LIST });

    expect(nodes.every((n) => n.kind === "single")).toBe(true);
    expect(singlePaths(nodes)).toEqual([MAIN, sub]);
  });

  it("跨路径形态（Windows / /mnt / WSL UNC）能匹配同一 worktree", () => {
    const mntMain = "/mnt/d/repo";
    const uncWorktree = "\\\\wsl.localhost\\Ubuntu\\mnt\\d\\repo-wt-a";
    const projects = [project("m", mntMain), project("a", uncWorktree)];
    const nodes = buildProjectTree(projects, { [mntMain]: FULL_LIST, [uncWorktree]: FULL_LIST });

    expect(nodes).toHaveLength(1);
    if (nodes[0].kind !== "group") throw new Error("expected group");
    expect(nodes[0].group.parent.id).toBe("m");
    expect(nodes[0].group.children[0].project.id).toBe("a");
  });

  it("SSH 项目不参与分组", () => {
    const ssh = project("s", "ssh://host/repo", {
      ssh: { host: "host", port: 22, remotePath: "/repo" },
    });
    const nodes = buildProjectTree([project("m", MAIN), ssh], { [MAIN]: FULL_LIST });
    expect(nodes.every((n) => n.kind === "single")).toBe(true);
  });

  // 回归护栏：缓存为空时输出必须与改造前的平铺逐条一致
  it("缓存缺失或为空时逐条平铺且保持顺序", () => {
    const projects = [project("m", MAIN), project("a", WT_A), project("b", WT_B)];
    expect(singlePaths(buildProjectTree(projects, {}))).toEqual([MAIN, WT_A, WT_B]);
    expect(singlePaths(buildProjectTree(projects, { [MAIN]: [], [WT_A]: [] })))
      .toEqual([MAIN, WT_A, WT_B]);
  });

  it("分组位置取组内首个成员的原始顺序", () => {
    const other = "D:\\other";
    const projects = [project("o", other), project("a", WT_A), project("m", MAIN)];
    const nodes = buildProjectTree(projects, {
      [other]: [entry(other, "main", true)],
      [WT_A]: FULL_LIST,
      [MAIN]: FULL_LIST,
    });

    expect(nodes).toHaveLength(2);
    expect(nodes[0].kind).toBe("single");
    expect(nodes[1].kind).toBe("group");
  });

  it("同一主仓库被重复注册时不吞掉任何项目", () => {
    const dupe = "/mnt/d/repo";
    const projects = [project("m1", MAIN), project("m2", dupe), project("a", WT_A)];
    const nodes = buildProjectTree(projects, {
      [MAIN]: FULL_LIST,
      [dupe]: FULL_LIST,
      [WT_A]: FULL_LIST,
    });

    const seen = new Set<string>();
    for (const node of nodes) {
      if (node.kind === "single") seen.add(node.project.id);
      else {
        seen.add(node.group.parent.id);
        node.group.children.forEach((c) => seen.add(c.project.id));
      }
    }
    expect(seen).toEqual(new Set(["m1", "m2", "a"]));
  });
});
