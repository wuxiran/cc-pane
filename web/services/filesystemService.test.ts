import { describe, it, expect, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { filesystemService } from "./filesystemService";
import {
  mockTauriInvoke,
  mockTauriInvokeError,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";

describe("filesystemService", () => {
  beforeEach(() => {
    resetTauriInvoke();
  });

  describe("listDirectory", () => {
    it("应该调用 fs_list_directory 并传递 path 和 showHidden", async () => {
      const listing = { path: "/tmp", entries: [] };
      mockTauriInvoke({ fs_list_directory: listing });

      const result = await filesystemService.listDirectory("/tmp", true);

      expect(invoke).toHaveBeenCalledWith("fs_list_directory", {
        path: "/tmp",
        showHidden: true,
      });
      expect(result).toEqual(listing);
    });
  });

  describe("readFile", () => {
    it("应该调用 fs_read_file 并返回文件内容", async () => {
      const content = { path: "/tmp/a.txt", content: "hello", truncated: false };
      mockTauriInvoke({ fs_read_file: content });

      const result = await filesystemService.readFile("/tmp/a.txt");

      expect(invoke).toHaveBeenCalledWith("fs_read_file", { path: "/tmp/a.txt" });
      expect(result).toEqual(content);
    });

    it("应该在读取失败时抛出错误", async () => {
      mockTauriInvokeError("fs_read_file", "permission denied");

      await expect(filesystemService.readFile("/root/secret")).rejects.toThrow(
        "permission denied",
      );
    });
  });

  describe("writeFile", () => {
    it("应该调用 fs_write_file 并传递内容", async () => {
      mockTauriInvoke({ fs_write_file: undefined });

      await filesystemService.writeFile("/tmp/a.txt", "new content");

      expect(invoke).toHaveBeenCalledWith("fs_write_file", {
        path: "/tmp/a.txt",
        content: "new content",
      });
    });
  });

  describe("createFile", () => {
    it("应该调用 fs_create_file", async () => {
      mockTauriInvoke({ fs_create_file: undefined });

      await filesystemService.createFile("/tmp/new.txt");

      expect(invoke).toHaveBeenCalledWith("fs_create_file", { path: "/tmp/new.txt" });
    });
  });

  describe("createDirectory", () => {
    it("应该调用 fs_create_directory", async () => {
      mockTauriInvoke({ fs_create_directory: undefined });

      await filesystemService.createDirectory("/tmp/newdir");

      expect(invoke).toHaveBeenCalledWith("fs_create_directory", {
        path: "/tmp/newdir",
      });
    });
  });

  describe("deleteEntry", () => {
    it("应该调用 fs_delete_entry（默认非永久删除）", async () => {
      mockTauriInvoke({ fs_delete_entry: undefined });

      await filesystemService.deleteEntry("/tmp/old.txt");

      expect(invoke).toHaveBeenCalledWith("fs_delete_entry", {
        path: "/tmp/old.txt",
        permanent: false,
      });
    });

    it("应该透传 permanent=true", async () => {
      mockTauriInvoke({ fs_delete_entry: undefined });

      await filesystemService.deleteEntry("/tmp/old.txt", true);

      expect(invoke).toHaveBeenCalledWith("fs_delete_entry", {
        path: "/tmp/old.txt",
        permanent: true,
      });
    });
  });

  describe("renameEntry", () => {
    it("应该调用 fs_rename_entry 并传递旧路径和新名称", async () => {
      mockTauriInvoke({ fs_rename_entry: undefined });

      await filesystemService.renameEntry("/tmp/old.txt", "new.txt");

      expect(invoke).toHaveBeenCalledWith("fs_rename_entry", {
        oldPath: "/tmp/old.txt",
        newName: "new.txt",
      });
    });
  });

  describe("copyEntry", () => {
    it("应该调用 fs_copy_entry 并传递源路径和目标目录", async () => {
      mockTauriInvoke({ fs_copy_entry: undefined });

      await filesystemService.copyEntry("/tmp/a.txt", "/tmp/dest");

      expect(invoke).toHaveBeenCalledWith("fs_copy_entry", {
        src: "/tmp/a.txt",
        destDir: "/tmp/dest",
      });
    });
  });

  describe("moveEntry", () => {
    it("应该调用 fs_move_entry 并传递源路径和目标目录", async () => {
      mockTauriInvoke({ fs_move_entry: undefined });

      await filesystemService.moveEntry("/tmp/a.txt", "/tmp/dest");

      expect(invoke).toHaveBeenCalledWith("fs_move_entry", {
        src: "/tmp/a.txt",
        destDir: "/tmp/dest",
      });
    });
  });

  describe("getEntryInfo", () => {
    it("应该调用 fs_get_entry_info 并返回条目信息", async () => {
      const entry = { name: "a.txt", path: "/tmp/a.txt", isDir: false };
      mockTauriInvoke({ fs_get_entry_info: entry });

      const result = await filesystemService.getEntryInfo("/tmp/a.txt");

      expect(invoke).toHaveBeenCalledWith("fs_get_entry_info", { path: "/tmp/a.txt" });
      expect(result).toEqual(entry);
    });
  });

  describe("getGitFileStatuses", () => {
    it("应该调用 get_git_file_statuses 并将 rootPath 映射为 path 参数", async () => {
      const statuses = { "src/a.ts": "modified" };
      mockTauriInvoke({ get_git_file_statuses: statuses });

      const result = await filesystemService.getGitFileStatuses("/tmp/repo");

      expect(invoke).toHaveBeenCalledWith("get_git_file_statuses", {
        path: "/tmp/repo",
      });
      expect(result).toEqual(statuses);
    });
  });

  describe("project search", () => {
    it("maps file-name search to search_project_files", async () => {
      const response = { paths: ["src/main.ts"], truncated: false };
      mockTauriInvoke({ search_project_files: response });

      const result = await filesystemService.searchProjectFiles("/repo", "main", 200);

      expect(invoke).toHaveBeenCalledWith("search_project_files", {
        root: "/repo",
        query: "main",
        limit: 200,
      });
      expect(result).toEqual(response);
    });

    it("maps content search to search_project_contents", async () => {
      const response = {
        matches: [{ path: "src/main.ts", line: 3, preview: "needle" }],
        truncated: false,
        timedOut: false,
      };
      mockTauriInvoke({ search_project_contents: response });

      const result = await filesystemService.searchProjectContents("/repo", "needle", 300);

      expect(invoke).toHaveBeenCalledWith("search_project_contents", {
        root: "/repo",
        query: "needle",
        limit: 300,
      });
      expect(result).toEqual(response);
    });
  });
});
