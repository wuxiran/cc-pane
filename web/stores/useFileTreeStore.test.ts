import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useFileTreeStore } from "./useFileTreeStore";
import { mockTauriInvoke, resetTauriInvoke } from "@/test/utils/mockTauriInvoke";
import type { FsEntry, FileTreeNode, DirListing } from "@/types/filesystem";

function entry(name: string, path: string, isDir: boolean): FsEntry {
  return {
    name,
    path,
    isDir,
    isFile: !isDir,
    isSymlink: false,
    size: 0,
    modified: null,
    extension: isDir ? null : name.split(".").pop() ?? null,
    hidden: false,
  };
}

function node(e: FsEntry, children: FileTreeNode[] | null, expanded = false): FileTreeNode {
  return { entry: e, children, expanded, loading: false };
}

function listing(path: string, entries: FsEntry[]): DirListing {
  return { path, entries };
}

const mockInvoke = invoke as ReturnType<typeof vi.fn>;

/** 构建一棵已加载的简单树 trees["/root"] */
function seedLoadedTree(): void {
  useFileTreeStore.setState({
    trees: {
      "/root": node(
        entry("root", "/root", true),
        [
          node(entry("a.txt", "/root/a.txt", false), []),
          node(entry("b", "/root/b", true), null),
        ],
        true,
      ),
    },
  });
}

describe("useFileTreeStore", () => {
  beforeEach(() => {
    resetTauriInvoke();
    useFileTreeStore.setState({
      trees: {},
      showHidden: false,
      selectedFilePath: null,
      gitStatuses: {},
    });
  });

  describe("初始状态", () => {
    it("应该有正确的初始值", () => {
      const state = useFileTreeStore.getState();
      expect(state.trees).toEqual({});
      expect(state.showHidden).toBe(false);
      expect(state.selectedFilePath).toBeNull();
      expect(state.gitStatuses).toEqual({});
    });
  });

  describe("loadDirectory", () => {
    it("首次加载应创建根节点并展开", async () => {
      mockTauriInvoke({
        fs_list_directory: listing("/root", [
          entry("a.txt", "/root/a.txt", false),
          entry("b", "/root/b", true),
        ]),
      });

      await useFileTreeStore.getState().loadDirectory("/root", "/root");

      const root = useFileTreeStore.getState().trees["/root"];
      expect(root).toBeDefined();
      expect(root.expanded).toBe(true);
      expect(root.children).toHaveLength(2);
      expect(root.children?.[0].entry.name).toBe("a.txt");
      // 文件节点 children 为 []，目录节点 children 为 null
      expect(root.children?.[0].children).toEqual([]);
      expect(root.children?.[1].children).toBeNull();
    });

    it("再次加载已存在的目录应更新其子节点", async () => {
      seedLoadedTree();
      mockTauriInvoke({
        fs_list_directory: listing("/root", [
          entry("a.txt", "/root/a.txt", false),
          entry("c.txt", "/root/c.txt", false),
        ]),
      });

      await useFileTreeStore.getState().loadDirectory("/root", "/root");

      const root = useFileTreeStore.getState().trees["/root"];
      expect(root.children).toHaveLength(2);
      expect(root.children?.map((c) => c.entry.name)).toEqual(["a.txt", "c.txt"]);
    });

    it("加载失败应抛错并将节点 children 置为 null", async () => {
      seedLoadedTree();
      mockTauriInvoke({
        fs_list_directory: () => {
          throw new Error("boom");
        },
      });

      await expect(
        useFileTreeStore.getState().loadDirectory("/root", "/root/b"),
      ).rejects.toThrow("boom");

      const root = useFileTreeStore.getState().trees["/root"];
      const bNode = root.children?.find((c) => c.entry.name === "b");
      expect(bNode?.children).toBeNull();
      expect(bNode?.loading).toBe(false);
    });

    it("首次加载失败应抛错且不创建根节点", async () => {
      mockTauriInvoke({
        fs_list_directory: () => {
          throw new Error("fail");
        },
      });

      await expect(
        useFileTreeStore.getState().loadDirectory("/root", "/root"),
      ).rejects.toThrow("fail");

      expect(useFileTreeStore.getState().trees["/root"]).toBeUndefined();
    });
  });

  describe("toggleExpand", () => {
    it("展开未加载的目录应触发加载", async () => {
      seedLoadedTree();
      mockTauriInvoke({
        fs_list_directory: listing("/root/b", [
          entry("d.txt", "/root/b/d.txt", false),
        ]),
      });

      await useFileTreeStore.getState().toggleExpand("/root", "/root/b");

      const root = useFileTreeStore.getState().trees["/root"];
      const bNode = root.children?.find((c) => c.entry.name === "b");
      expect(bNode?.expanded).toBe(true);
      expect(bNode?.children).toHaveLength(1);
    });

    it("折叠已展开的目录", async () => {
      useFileTreeStore.setState({
        trees: {
          "/root": node(
            entry("root", "/root", true),
            [node(entry("b", "/root/b", true), [], true)],
            true,
          ),
        },
      });

      await useFileTreeStore.getState().toggleExpand("/root", "/root/b");

      const root = useFileTreeStore.getState().trees["/root"];
      expect(root.children?.[0].expanded).toBe(false);
    });

    it("根路径不存在时应直接返回", async () => {
      await useFileTreeStore.getState().toggleExpand("/nope", "/nope/x");
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("对文件节点无效", async () => {
      seedLoadedTree();
      await useFileTreeStore.getState().toggleExpand("/root", "/root/a.txt");
      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });

  describe("refresh", () => {
    it("不带 dirPath 时刷新根目录", async () => {
      seedLoadedTree();
      mockTauriInvoke({
        fs_list_directory: listing("/root", [entry("a.txt", "/root/a.txt", false)]),
      });

      await useFileTreeStore.getState().refresh("/root");

      expect(mockInvoke).toHaveBeenCalledWith("fs_list_directory", {
        path: "/root",
        showHidden: false,
      });
    });

    it("带 dirPath 时刷新指定目录", async () => {
      seedLoadedTree();
      mockTauriInvoke({
        fs_list_directory: listing("/root/b", []),
      });

      await useFileTreeStore.getState().refresh("/root", "/root/b");

      expect(mockInvoke).toHaveBeenCalledWith("fs_list_directory", {
        path: "/root/b",
        showHidden: false,
      });
    });
  });

  describe("clearTree", () => {
    it("应删除指定根路径的树和 git 状态", () => {
      seedLoadedTree();
      useFileTreeStore.setState({ gitStatuses: { "/root": { "a.txt": "M" } } });

      useFileTreeStore.getState().clearTree("/root");

      expect(useFileTreeStore.getState().trees["/root"]).toBeUndefined();
      expect(useFileTreeStore.getState().gitStatuses["/root"]).toBeUndefined();
    });
  });

  describe("toggleShowHidden", () => {
    it("应切换 showHidden 标志", () => {
      useFileTreeStore.getState().toggleShowHidden();
      expect(useFileTreeStore.getState().showHidden).toBe(true);
      useFileTreeStore.getState().toggleShowHidden();
      expect(useFileTreeStore.getState().showHidden).toBe(false);
    });

    it("切换后应刷新已加载的树", async () => {
      seedLoadedTree();
      mockTauriInvoke({
        fs_list_directory: listing("/root", []),
      });

      useFileTreeStore.getState().toggleShowHidden();
      // refresh 是 fire-and-forget，等待微任务
      await Promise.resolve();
      await Promise.resolve();

      expect(mockInvoke).toHaveBeenCalledWith("fs_list_directory", {
        path: "/root",
        showHidden: true,
      });
    });
  });

  describe("setSelectedFilePath", () => {
    it("应设置选中文件路径", () => {
      useFileTreeStore.getState().setSelectedFilePath("/root/a.txt");
      expect(useFileTreeStore.getState().selectedFilePath).toBe("/root/a.txt");
    });

    it("应可清空选中", () => {
      useFileTreeStore.setState({ selectedFilePath: "/root/a.txt" });
      useFileTreeStore.getState().setSelectedFilePath(null);
      expect(useFileTreeStore.getState().selectedFilePath).toBeNull();
    });
  });

  describe("revealFile", () => {
    it("应展开中间目录并高亮目标文件", async () => {
      useFileTreeStore.setState({
        trees: {
          "/root": node(
            entry("root", "/root", true),
            [
              node(
                entry("b", "/root/b", true),
                [
                  node(
                    entry("c", "/root/b/c", true),
                    [node(entry("file.txt", "/root/b/c/file.txt", false), [])],
                  ),
                ],
              ),
            ],
            true,
          ),
        },
      });

      await useFileTreeStore.getState().revealFile("/root", "/root/b/c/file.txt");

      const root = useFileTreeStore.getState().trees["/root"];
      const b = root.children?.[0];
      const c = b?.children?.[0];
      expect(b?.expanded).toBe(true);
      expect(c?.expanded).toBe(true);
      expect(useFileTreeStore.getState().selectedFilePath).toBe("/root/b/c/file.txt");
    });

    it("filePath 不在 rootPath 下时应直接返回", async () => {
      seedLoadedTree();
      await useFileTreeStore.getState().revealFile("/root", "/other/x.txt");
      expect(useFileTreeStore.getState().selectedFilePath).toBeNull();
    });
  });

  describe("collapseAll", () => {
    it("应折叠整棵树（包括根节点）", () => {
      useFileTreeStore.setState({
        trees: {
          "/root": node(
            entry("root", "/root", true),
            [node(entry("b", "/root/b", true), [node(entry("c", "/root/b/c", true), [], true)], true)],
            true,
          ),
        },
      });

      useFileTreeStore.getState().collapseAll("/root");

      const root = useFileTreeStore.getState().trees["/root"];
      expect(root.expanded).toBe(false);
      expect(root.children?.[0].expanded).toBe(false);
      expect(root.children?.[0].children?.[0].expanded).toBe(false);
    });

    it("根路径不存在时应安全返回", () => {
      expect(() => useFileTreeStore.getState().collapseAll("/nope")).not.toThrow();
    });
  });

  describe("loadGitStatuses", () => {
    it("成功时应保存 git 状态", async () => {
      mockTauriInvoke({
        get_git_file_statuses: { "a.txt": "M", "b.txt": "A" },
      });

      await useFileTreeStore.getState().loadGitStatuses("/root");

      expect(useFileTreeStore.getState().gitStatuses["/root"]).toEqual({
        "a.txt": "M",
        "b.txt": "A",
      });
    });

    it("失败时应置为空对象", async () => {
      mockTauriInvoke({
        get_git_file_statuses: () => {
          throw new Error("not a git repo");
        },
      });

      await useFileTreeStore.getState().loadGitStatuses("/root");

      expect(useFileTreeStore.getState().gitStatuses["/root"]).toEqual({});
    });
  });

  describe("CRUD 操作", () => {
    it("createFile 应创建文件并刷新父目录", async () => {
      seedLoadedTree();
      mockTauriInvoke({
        fs_create_file: undefined,
        fs_list_directory: listing("/root", []),
      });

      await useFileTreeStore.getState().createFile("/root", "new.txt", "/root");

      expect(mockInvoke).toHaveBeenCalledWith("fs_create_file", {
        path: "/root/new.txt",
      });
      expect(mockInvoke).toHaveBeenCalledWith("fs_list_directory", {
        path: "/root",
        showHidden: false,
      });
    });

    it("createDirectory 应创建目录并刷新", async () => {
      seedLoadedTree();
      mockTauriInvoke({
        fs_create_directory: undefined,
        fs_list_directory: listing("/root", []),
      });

      await useFileTreeStore.getState().createDirectory("/root", "sub", "/root");

      expect(mockInvoke).toHaveBeenCalledWith("fs_create_directory", {
        path: "/root/sub",
      });
    });

    it("deleteEntry 应删除并刷新父目录", async () => {
      seedLoadedTree();
      mockTauriInvoke({
        fs_delete_entry: undefined,
        fs_list_directory: listing("/root", []),
      });

      await useFileTreeStore.getState().deleteEntry("/root/a.txt", "/root");

      expect(mockInvoke).toHaveBeenCalledWith("fs_delete_entry", {
        path: "/root/a.txt",
      });
      expect(mockInvoke).toHaveBeenCalledWith("fs_list_directory", {
        path: "/root",
        showHidden: false,
      });
    });

    it("renameEntry 应重命名并刷新父目录", async () => {
      seedLoadedTree();
      mockTauriInvoke({
        fs_rename_entry: undefined,
        fs_list_directory: listing("/root", []),
      });

      await useFileTreeStore.getState().renameEntry("/root/a.txt", "b.txt", "/root");

      expect(mockInvoke).toHaveBeenCalledWith("fs_rename_entry", {
        oldPath: "/root/a.txt",
        newName: "b.txt",
      });
    });

    it("copyEntry 应复制并刷新目标目录", async () => {
      seedLoadedTree();
      mockTauriInvoke({
        fs_copy_entry: undefined,
        fs_list_directory: listing("/root/b", []),
      });

      await useFileTreeStore.getState().copyEntry("/root/a.txt", "/root/b", "/root");

      expect(mockInvoke).toHaveBeenCalledWith("fs_copy_entry", {
        src: "/root/a.txt",
        destDir: "/root/b",
      });
      expect(mockInvoke).toHaveBeenCalledWith("fs_list_directory", {
        path: "/root/b",
        showHidden: false,
      });
    });

    it("moveEntry 应移动并刷新源与目标目录", async () => {
      seedLoadedTree();
      mockTauriInvoke({
        fs_move_entry: undefined,
        fs_list_directory: listing("/root", []),
      });

      await useFileTreeStore.getState().moveEntry("/root/a.txt", "/root/b", "/root");

      expect(mockInvoke).toHaveBeenCalledWith("fs_move_entry", {
        src: "/root/a.txt",
        destDir: "/root/b",
      });
      // 源父目录 "/root" 与目标 "/root/b" 都会刷新
      const listCalls = mockInvoke.mock.calls.filter((c) => c[0] === "fs_list_directory");
      const paths = listCalls.map((c) => (c[1] as { path: string }).path);
      expect(paths).toContain("/root");
      expect(paths).toContain("/root/b");
    });
  });
});
