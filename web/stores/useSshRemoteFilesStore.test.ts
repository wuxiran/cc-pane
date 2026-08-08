import { beforeEach, describe, expect, it } from "vitest";
import { useSshRemoteFilesStore } from "./useSshRemoteFilesStore";

describe("useSshRemoteFilesStore", () => {
  beforeEach(() => {
    useSshRemoteFilesStore.setState({
      sessionPasswordMachineIds: [],
      directoryCache: {},
    });
    useSshRemoteFilesStore.getState().clear();
  });

  it("opens a machine at its default path and navigates history", () => {
    const store = useSshRemoteFilesStore.getState();
    store.openMachine("m-1", "/srv/app/");
    useSshRemoteFilesStore.getState().navigateTo("/srv/app/src");

    expect(useSshRemoteFilesStore.getState()).toMatchObject({
      machineId: "m-1",
      currentPath: "/srv/app/src",
      history: ["/srv/app", "/srv/app/src"],
      historyIndex: 1,
    });

    useSshRemoteFilesStore.getState().goBack();
    expect(useSshRemoteFilesStore.getState().currentPath).toBe("/srv/app");
    useSshRemoteFilesStore.getState().goForward();
    expect(useSshRemoteFilesStore.getState().currentPath).toBe("/srv/app/src");
  });

  it("opens a machine at the remote root when no default path is configured", () => {
    useSshRemoteFilesStore.getState().openMachine("m-1");

    expect(useSshRemoteFilesStore.getState()).toMatchObject({
      machineId: "m-1",
      currentPath: "/",
      history: ["/"],
      historyIndex: 0,
    });
  });

  it("replaces a tilde path after the server resolves the remote home", () => {
    useSshRemoteFilesStore.getState().openMachine("m-1", "~");
    useSshRemoteFilesStore.getState().replaceCurrentPath("/root");

    expect(useSshRemoteFilesStore.getState()).toMatchObject({
      currentPath: "/root",
      history: ["/root"],
      historyIndex: 0,
    });
  });

  it("does not navigate above the remote root", () => {
    useSshRemoteFilesStore.getState().openMachine("m-1", "/");
    useSshRemoteFilesStore.getState().goUp();
    expect(useSshRemoteFilesStore.getState().currentPath).toBe("/");
  });

  it("shares in-memory password readiness across SSH views", () => {
    useSshRemoteFilesStore.getState().markSessionPassword("m-1");
    expect(useSshRemoteFilesStore.getState().hasSessionPassword("m-1")).toBe(true);

    useSshRemoteFilesStore.getState().forgetSessionPassword("m-1");
    expect(useSshRemoteFilesStore.getState().hasSessionPassword("m-1")).toBe(false);
  });

  it("caches listings by machine, path, and hidden-file mode", () => {
    const listing = { path: "/root", entries: [] };
    useSshRemoteFilesStore.getState().cacheDirectory("m-1", "~", true, listing);

    expect(useSshRemoteFilesStore.getState().getCachedDirectory("m-1", "~", true)).toBe(listing);
    expect(useSshRemoteFilesStore.getState().getCachedDirectory("m-1", "/root", true)).toBe(listing);
    expect(useSshRemoteFilesStore.getState().getCachedDirectory("m-1", "/root", false)).toBeUndefined();
    expect(useSshRemoteFilesStore.getState().getCachedDirectory("m-2", "/root", true)).toBeUndefined();
  });
});
