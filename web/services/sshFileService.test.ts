import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { mockTauriInvoke, resetTauriInvoke } from "@/test/utils/mockTauriInvoke";
import { sshFileService } from "./sshFileService";

const originalTauriInternals = window.__TAURI_INTERNALS__;

describe("sshFileService", () => {
  beforeEach(() => {
    resetTauriInvoke();
    window.__TAURI_INTERNALS__ = originalTauriInternals ?? {};
  });

  afterEach(() => {
    window.__TAURI_INTERNALS__ = originalTauriInternals;
  });

  it("routes directory and file operations through SSH-specific commands", async () => {
    const listing = { path: "/srv/app", entries: [] };
    const file = {
      path: "/srv/app/readme.txt",
      content: "hello",
      encoding: "utf-8",
      size: 5,
      language: null,
    };
    const image = {
      path: "/srv/app/logo.png",
      dataBase64: "aW1hZ2U=",
      mimeType: "image/png",
      size: 5,
    };
    mockTauriInvoke({
      ssh_fs_configure_password: undefined,
      ssh_fs_list_directory: listing,
      ssh_fs_read_file: file,
      ssh_fs_read_image: image,
      ssh_fs_write_file: undefined,
      ssh_fs_create_file: undefined,
      ssh_fs_create_directory: undefined,
      ssh_fs_rename_entry: undefined,
      ssh_fs_delete_entry: undefined,
      ssh_fs_upload_file: 7,
      ssh_fs_download_file: 7,
      ssh_fs_set_permissions: undefined,
    });

    await sshFileService.configurePassword("m-1", "secret", false);
    await expect(sshFileService.listDirectory("m-1", "/srv/app", true)).resolves.toEqual(listing);
    await expect(sshFileService.readFile("m-1", "/srv/app/readme.txt")).resolves.toEqual(file);
    await expect(sshFileService.readImage("m-1", "/srv/app/logo.png")).resolves.toEqual(image);
    await sshFileService.writeFile("m-1", "/srv/app/readme.txt", "updated");
    await sshFileService.createFile("m-1", "/srv/app", "new.txt");
    await sshFileService.createDirectory("m-1", "/srv/app", "src");
    await sshFileService.renameEntry("m-1", "/srv/app/new.txt", "renamed.txt");
    await sshFileService.deleteEntry("m-1", "/srv/app/renamed.txt");
    await expect(sshFileService.uploadFile("m-1", "C:\\tmp\\a.txt", "/srv/app")).resolves.toBe(7);
    await expect(sshFileService.downloadFile("m-1", "/srv/app/a.txt", "C:\\tmp\\a.txt")).resolves.toBe(7);
    await sshFileService.setPermissions("m-1", "/srv/app/a.txt", 0o640);

    expect(invoke).toHaveBeenCalledWith("ssh_fs_list_directory", {
      machineId: "m-1",
      path: "/srv/app",
      showHidden: true,
    });
    expect(invoke).toHaveBeenCalledWith("ssh_fs_configure_password", {
      machineId: "m-1",
      password: "secret",
      remember: false,
    });
    expect(invoke).toHaveBeenCalledWith("ssh_fs_write_file", {
      machineId: "m-1",
      path: "/srv/app/readme.txt",
      content: "updated",
    });
    expect(invoke).toHaveBeenCalledWith("ssh_fs_read_image", {
      machineId: "m-1",
      path: "/srv/app/logo.png",
    });
    expect(invoke).toHaveBeenCalledWith("ssh_fs_rename_entry", {
      machineId: "m-1",
      path: "/srv/app/new.txt",
      newName: "renamed.txt",
    });
    expect(invoke).toHaveBeenCalledWith("ssh_fs_upload_file", {
      machineId: "m-1",
      localPath: "C:\\tmp\\a.txt",
      remoteParent: "/srv/app",
    });
    expect(invoke).toHaveBeenCalledWith("ssh_fs_set_permissions", {
      machineId: "m-1",
      path: "/srv/app/a.txt",
      mode: 0o640,
    });
  });
});
