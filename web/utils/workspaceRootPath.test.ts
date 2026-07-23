import { describe, expect, it } from "vitest";
import type { Workspace } from "@/types";
import { resolveWorkspaceRootPath } from "./workspaceRootPath";

type WorkspaceRootInput = Pick<Workspace, "path" | "projects">;

function workspace(path: string | undefined, projectPaths: string[]): WorkspaceRootInput {
  return {
    path,
    projects: projectPaths.map((projectPath, index) => ({
      id: `project-${index}`,
      path: projectPath,
    })),
  };
}

describe("resolveWorkspaceRootPath", () => {
  it("优先使用 workspace.path 并规范化分隔符", () => {
    expect(resolveWorkspaceRootPath(workspace("D:\\workspace\\demo\\", ["D:/other/project"])))
      .toBe("D:/workspace/demo");
  });

  it("workspace.path 缺失时返回多个项目的最长公共父目录", () => {
    expect(resolveWorkspaceRootPath(workspace(undefined, [
      "D:\\workspace\\app-one",
      "D:/workspace/app-two/nested",
    ]))).toBe("D:/workspace");
  });

  it("单项目时返回项目路径", () => {
    expect(resolveWorkspaceRootPath(workspace(undefined, ["/srv/projects/app/"])))
      .toBe("/srv/projects/app");
  });

  it("项目跨盘符时回退到第一个项目路径", () => {
    expect(resolveWorkspaceRootPath(workspace(undefined, ["C:/projects/app", "D:/projects/api"])))
      .toBe("C:/projects/app");
  });

  it("项目路径求不出公共父目录时回退到第一个项目路径", () => {
    expect(resolveWorkspaceRootPath(workspace(undefined, ["alpha/app", "beta/api"])))
      .toBe("alpha/app");
  });

  it("空工作空间返回 null", () => {
    expect(resolveWorkspaceRootPath(workspace(undefined, []))).toBeNull();
  });
});
