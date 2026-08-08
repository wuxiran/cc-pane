import type { DirListing, FileContent, ImageFileContent } from "@/types/filesystem";
import { apiGet, apiJson, invokeOrApi } from "./apiClient";

export const sshFileService = {
  configurePassword(machineId: string, password: string, remember: boolean): Promise<void> {
    return invokeOrApi<void>(
      "ssh_fs_configure_password",
      { machineId, password, remember },
      () => apiJson<void>("/api/ssh-files/password", "POST", {
        machineId,
        password,
        remember,
      }),
    );
  },

  listDirectory(machineId: string, path: string, showHidden: boolean): Promise<DirListing> {
    return invokeOrApi<DirListing>(
      "ssh_fs_list_directory",
      { machineId, path, showHidden },
      () => apiGet<DirListing>("/api/ssh-files/list", { machineId, path, showHidden }),
    );
  },

  readFile(machineId: string, path: string): Promise<FileContent> {
    return invokeOrApi<FileContent>(
      "ssh_fs_read_file",
      { machineId, path },
      () => apiGet<FileContent>("/api/ssh-files/read", { machineId, path }),
    );
  },

  readImage(machineId: string, path: string): Promise<ImageFileContent> {
    return invokeOrApi<ImageFileContent>(
      "ssh_fs_read_image",
      { machineId, path },
      () => apiGet<ImageFileContent>("/api/ssh-files/read-image", { machineId, path }),
    );
  },

  writeFile(machineId: string, path: string, content: string): Promise<void> {
    return invokeOrApi<void>(
      "ssh_fs_write_file",
      { machineId, path, content },
      () => apiJson<void>("/api/ssh-files/write", "POST", { machineId, path, content }),
    );
  },

  createFile(machineId: string, parent: string, name: string): Promise<void> {
    return invokeOrApi<void>(
      "ssh_fs_create_file",
      { machineId, parent, name },
      () => apiJson<void>("/api/ssh-files/create-file", "POST", { machineId, parent, name }),
    );
  },

  createDirectory(machineId: string, parent: string, name: string): Promise<void> {
    return invokeOrApi<void>(
      "ssh_fs_create_directory",
      { machineId, parent, name },
      () => apiJson<void>("/api/ssh-files/create-directory", "POST", { machineId, parent, name }),
    );
  },

  renameEntry(machineId: string, path: string, newName: string): Promise<void> {
    return invokeOrApi<void>(
      "ssh_fs_rename_entry",
      { machineId, path, newName },
      () => apiJson<void>("/api/ssh-files/rename", "POST", { machineId, path, newName }),
    );
  },

  deleteEntry(machineId: string, path: string): Promise<void> {
    return invokeOrApi<void>(
      "ssh_fs_delete_entry",
      { machineId, path },
      () => apiJson<void>("/api/ssh-files/delete", "POST", { machineId, path }),
    );
  },

  uploadFile(machineId: string, localPath: string, remoteParent: string): Promise<number> {
    return invokeOrApi<number>(
      "ssh_fs_upload_file",
      { machineId, localPath, remoteParent },
      () => apiJson<number>("/api/ssh-files/upload", "POST", {
        machineId,
        localPath,
        remoteParent,
      }),
    );
  },

  downloadFile(machineId: string, remotePath: string, localPath: string): Promise<number> {
    return invokeOrApi<number>(
      "ssh_fs_download_file",
      { machineId, remotePath, localPath },
      () => apiJson<number>("/api/ssh-files/download", "POST", {
        machineId,
        remotePath,
        localPath,
      }),
    );
  },

  setPermissions(machineId: string, path: string, mode: number): Promise<void> {
    return invokeOrApi<void>(
      "ssh_fs_set_permissions",
      { machineId, path, mode },
      () => apiJson<void>("/api/ssh-files/permissions", "POST", {
        machineId,
        path,
        mode,
      }),
    );
  },
};
